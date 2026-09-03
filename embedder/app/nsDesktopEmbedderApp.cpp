/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsXULAppAPI.h"

#include <stdio.h>

#if defined(XP_WIN)
#  include <windows.h>

#  include "LauncherProcessWin.h"
#  include "freestanding/SharedSection.h"
#  include "mozilla/GeckoArgs.h"
#  include "mozilla/WindowsDllBlocklist.h"
#  include "mozilla/WindowsDpiInitialization.h"
#  include "mozilla/WindowsProcessMitigations.h"

#  define strcasecmp _stricmp
#  include "nsWindowsWMain.cpp"

#  ifdef MOZ_SANDBOX
#    include "mozilla/sandboxing/SandboxInitialization.h"
#    include "mozilla/sandboxing/sandboxLogging.h"
#  endif
#elif defined(XP_UNIX)
#  include <fcntl.h>
#  include <strings.h>
#  include <unistd.h>
#endif

#include "BinaryPath.h"
#include "XREChildData.h"
#include "application.ini.h"
#include "mozilla/Bootstrap.h"
#include "mozilla/CmdLineAndEnvUtils.h"
#include "mozilla/ProcessType.h"
#include "mozilla/RuntimeExceptionModule.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/StartupTimeline.h"
#include "mozilla/TimeStamp.h"
#include "nsXPCOMPrivate.h"

using namespace mozilla;

// MOZ_RUNINIT is available across the supported ESR range. Newer Gecko
// launchers spell this as C++20 constinit, while ESR 140 still builds this
// standalone executable with the older language mode.
MOZ_RUNINIT Bootstrap::UniquePtr gBootstrap;

#ifdef HAS_DLL_BLOCKLIST
// This value is populated by the launcher process before control reaches the
// main browser process.
uint32_t gBlocklistInitFlags = eDllBlocklistInitFlagDefault;
#endif

static bool IsFlag(const char* aArgument, const char* aFlag) {
  if (*aArgument != '-') {
    return false;
  }
  if (*++aArgument == '-') {
    ++aArgument;
  }
  return !strcasecmp(aArgument, aFlag);
}

static nsresult InitXPCOMGlue(LibLoadingStrategy aStrategy) {
  if (gBootstrap) {
    return NS_OK;
  }

  UniqueFreePtr<char> executablePath = BinaryPath::Get();
  if (!executablePath) {
    fprintf(stderr,
            "Desktop embedder could not resolve its executable path.\n");
    return NS_ERROR_FAILURE;
  }

  auto bootstrap = GetBootstrap(executablePath.get(), aStrategy);
  if (bootstrap.isErr()) {
    fprintf(stderr, "Desktop embedder could not load XPCOM.\n");
    return NS_ERROR_FAILURE;
  }

  gBootstrap = bootstrap.unwrap();
  gBootstrap->NS_LogInit();
  return NS_OK;
}

static int RunParentProcess(int aArgc, char* aArgv[]) {
  constexpr const char* allowedParameters[] = {"url"};
  EnsureCommandlineSafe(aArgc, aArgv, allowedParameters);

  BootstrapConfig config{};
  config.appData = &sAppData;
  config.appDataPath = "";

#if defined(XP_WIN) && defined(MOZ_SANDBOX)
  config.sandboxBrokerServices = sandboxing::GetInitializedBrokerServices();
  if (!config.sandboxBrokerServices) {
    fprintf(stderr,
            "Desktop embedder could not initialize sandbox broker services.\n");
    return 255;
  }
#endif

  return gBootstrap->XRE_main(aArgc, aArgv, config);
}

#if defined(XP_UNIX)
static void ReserveStandardFileDescriptors() {
  int descriptor = open("/dev/null", O_RDONLY);
  for (int index = 0; index < 2 && descriptor >= 0; ++index) {
    descriptor = dup(descriptor);
  }
}
#endif

int main(int argc, char* argv[]) {
#if defined(XP_UNIX)
  ReserveStandardFileDescriptors();
#endif

  if (argc > 1 && IsFlag(argv[1], "contentproc")) {
    SetGeckoProcessType(argv[--argc]);
    SetGeckoChildID(argv[--argc]);

#ifdef MOZ_ENABLE_FORKSERVER
    if (GetGeckoProcessType() == GeckoProcessType_ForkServer) {
      nsresult result = InitXPCOMGlue(LibLoadingStrategy::NoReadAhead);
      if (NS_FAILED(result)) {
        return 255;
      }
      if (gBootstrap->XRE_ForkServer(&argc, &argv)) {
        gBootstrap->NS_LogTerm();
        return 0;
      }
    }
#endif
  }

  TimeStamp start = TimeStamp::Now();
  CrashReporter::RegisterRuntimeExceptionModule();
  auto unregisterRuntimeExceptionModule =
      MakeScopeExit([] { CrashReporter::UnregisterRuntimeExceptionModule(); });

  if (GetGeckoProcessType() != GeckoProcessType_Default) {
#ifdef HAS_DLL_BLOCKLIST
    uint32_t blocklistInitFlags =
        gBlocklistInitFlags | eDllBlocklistInitFlagIsChildProcess;
    SetDllBlocklistProcessTypeFlags(blocklistInitFlags, GetGeckoProcessType());
    DllBlocklist_Initialize(blocklistInitFlags);
#endif

#if defined(XP_WIN) && defined(MOZ_SANDBOX)
    Maybe<bool> win32kLockedDown = geckoargs::sWin32kLockedDown.Get(argc, argv);
    if (win32kLockedDown.isSome() && *win32kLockedDown) {
      SetWin32kLockedDownInPolicy();
    }

    if (IsSandboxedProcess() && !sandboxing::GetInitializedTargetServices()) {
      fprintf(stderr,
              "Desktop embedder could not initialize sandbox target services.\n");
      return 255;
    }
#endif

#if defined(XP_WIN)
    {
      auto dpiResult = WindowsDpiInitialization();
      (void)dpiResult;
    }
#endif

    nsresult result = InitXPCOMGlue(LibLoadingStrategy::NoReadAhead);
    if (NS_FAILED(result)) {
      return 255;
    }

    XREChildData childData;

#if defined(XP_WIN) && defined(MOZ_SANDBOX)
    if (IsSandboxedProcess()) {
      childData.sandboxTargetServices =
          sandboxing::GetInitializedTargetServices();
      if (!childData.sandboxTargetServices) {
        return 1;
      }
      childData.ProvideLogFunction = sandboxing::ProvideLogFunction;
    }
#endif

    result = gBootstrap->XRE_InitChildProcess(argc, argv, &childData);

#if defined(DEBUG) && defined(HAS_DLL_BLOCKLIST)
    DllBlocklist_Shutdown();
#endif

    gBootstrap->NS_LogTerm();
    return NS_FAILED(result) ? 1 : 0;
  }

#ifdef HAS_DLL_BLOCKLIST
  DllBlocklist_Initialize(gBlocklistInitFlags);
#endif

#if defined(XP_WIN)
  {
    auto dpiResult = WindowsDpiInitialization();
    (void)dpiResult;
  }

  // The launcher has finished loading dependent modules, so child processes
  // only need read access to the shared blocklist section from this point on.
  freestanding::gSharedSection.ConvertToReadOnly();
#endif

  nsresult result = InitXPCOMGlue(LibLoadingStrategy::ReadAhead);
  if (NS_FAILED(result)) {
    return 255;
  }

  gBootstrap->XRE_StartupTimelineRecord(StartupTimeline::START, start);
  gBootstrap->XRE_EnableSameExecutableForContentProc();

  int exitCode = RunParentProcess(argc, argv);
  gBootstrap->NS_LogTerm();

#if defined(DEBUG) && defined(HAS_DLL_BLOCKLIST)
  DllBlocklist_Shutdown();
#endif

  gBootstrap.reset();
  return exitCode;
}
