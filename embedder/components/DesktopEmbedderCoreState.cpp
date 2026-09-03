/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "DesktopEmbedderCoreState.h"

#include "NavisCoreFFI.h"
#include "nsError.h"
#include "nsString.h"

#include <limits>

namespace mozilla::desktop {

namespace {

nsresult ToNsresult(NavisCoreStatus aStatus) {
  switch (aStatus) {
    case NAVIS_CORE_OK:
      return NS_OK;
    case NAVIS_CORE_NULL_POINTER:
      return NS_ERROR_NULL_POINTER;
    case NAVIS_CORE_CLOSED:
      return NS_ERROR_NOT_AVAILABLE;
    case NAVIS_CORE_UNKNOWN_WINDOW:
    case NAVIS_CORE_UNKNOWN_VIEW:
    case NAVIS_CORE_UNKNOWN_SESSION:
      return NS_ERROR_INVALID_ARG;
    case NAVIS_CORE_CONFLICT:
      return NS_ERROR_ILLEGAL_VALUE;
    case NAVIS_CORE_INVARIANT_VIOLATION:
    case NAVIS_CORE_IDENTIFIER_EXHAUSTED:
      return NS_ERROR_UNEXPECTED;
    case NAVIS_CORE_INVALID_ARGUMENT:
      return NS_ERROR_INVALID_ARG;
  }
  return NS_ERROR_UNEXPECTED;
}

}  // namespace

class DesktopEmbedderNavigationState final
    : public nsIDesktopEmbedderNavigationState {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIDESKTOPEMBEDDERNAVIGATIONSTATE

  explicit DesktopEmbedderNavigationState(
      const NavisCoreNavigationSnapshot& aSnapshot)
      : mRevision(aSnapshot.revision),
        mNavigationId(aSnapshot.navigation_id),
        mLoading(aSnapshot.activity != NAVIS_CORE_NAVIGATION_ACTIVITY_IDLE),
        mLoadingActivity(aSnapshot.activity),
        mSecurity(aSnapshot.security),
        mIdentity(aSnapshot.identity),
        mCanGoBack(aSnapshot.can_go_back),
        mCanGoForward(aSnapshot.can_go_forward),
        mHasFailure(aSnapshot.has_failure),
        mFailureCode(aSnapshot.failure_code) {
    mUrl.Assign(reinterpret_cast<const char*>(aSnapshot.url),
                static_cast<uint32_t>(aSnapshot.url_length));
    mTitle.Assign(reinterpret_cast<const char*>(aSnapshot.title),
                  static_cast<uint32_t>(aSnapshot.title_length));
    mIdentityKey.Assign(reinterpret_cast<const char*>(aSnapshot.identity_key),
                        static_cast<uint32_t>(aSnapshot.identity_key_length));
  }

 private:
  ~DesktopEmbedderNavigationState() = default;

  uint64_t mRevision;
  uint64_t mNavigationId;
  nsCString mUrl;
  nsCString mTitle;
  bool mLoading;
  uint32_t mLoadingActivity;
  uint32_t mSecurity;
  uint32_t mIdentity;
  nsCString mIdentityKey;
  bool mCanGoBack;
  bool mCanGoForward;
  bool mHasFailure;
  uint32_t mFailureCode;
};

NS_IMPL_ISUPPORTS(DesktopEmbedderNavigationState,
                  nsIDesktopEmbedderNavigationState)

NS_IMETHODIMP DesktopEmbedderNavigationState::GetRevision(uint64_t* aValue) {
  *aValue = mRevision;
  return NS_OK;
}

NS_IMETHODIMP
DesktopEmbedderNavigationState::GetNavigationId(uint64_t* aValue) {
  *aValue = mNavigationId;
  return NS_OK;
}

NS_IMETHODIMP
DesktopEmbedderNavigationState::GetUrl(nsACString& aValue) {
  aValue = mUrl;
  return NS_OK;
}

NS_IMETHODIMP
DesktopEmbedderNavigationState::GetTitle(nsACString& aValue) {
  aValue = mTitle;
  return NS_OK;
}

NS_IMETHODIMP DesktopEmbedderNavigationState::GetLoading(bool* aValue) {
  *aValue = mLoading;
  return NS_OK;
}

NS_IMETHODIMP DesktopEmbedderNavigationState::GetLoadingActivity(
    uint32_t* aValue) {
  *aValue = mLoadingActivity;
  return NS_OK;
}

NS_IMETHODIMP DesktopEmbedderNavigationState::GetSecurity(uint32_t* aValue) {
  *aValue = mSecurity;
  return NS_OK;
}

NS_IMETHODIMP DesktopEmbedderNavigationState::GetIdentity(uint32_t* aValue) {
  *aValue = mIdentity;
  return NS_OK;
}

NS_IMETHODIMP
DesktopEmbedderNavigationState::GetIdentityKey(nsACString& aValue) {
  aValue = mIdentityKey;
  return NS_OK;
}

NS_IMETHODIMP DesktopEmbedderNavigationState::GetCanGoBack(bool* aValue) {
  *aValue = mCanGoBack;
  return NS_OK;
}

NS_IMETHODIMP DesktopEmbedderNavigationState::GetCanGoForward(bool* aValue) {
  *aValue = mCanGoForward;
  return NS_OK;
}

NS_IMETHODIMP DesktopEmbedderNavigationState::GetHasFailure(bool* aValue) {
  *aValue = mHasFailure;
  return NS_OK;
}

NS_IMETHODIMP DesktopEmbedderNavigationState::GetFailureCode(uint32_t* aValue) {
  *aValue = mFailureCode;
  return NS_OK;
}

NS_IMPL_ISUPPORTS(DesktopEmbedderCoreState, nsIDesktopEmbedderCoreState)

DesktopEmbedderCoreState::DesktopEmbedderCoreState()
    : mRuntime(navis_core_runtime_new()) {}

DesktopEmbedderCoreState::~DesktopEmbedderCoreState() {
  navis_core_runtime_free(mRuntime);
}

NS_IMETHODIMP DesktopEmbedderCoreState::GetClosed(bool* aClosed) {
  return ToNsresult(navis_core_runtime_is_closed(mRuntime, aClosed));
}

NS_IMETHODIMP DesktopEmbedderCoreState::GetWindowCount(uint64_t* aCount) {
  return ToNsresult(navis_core_runtime_window_count(mRuntime, aCount));
}

NS_IMETHODIMP DesktopEmbedderCoreState::GetSessionCount(uint64_t* aCount) {
  return ToNsresult(navis_core_runtime_session_count(mRuntime, aCount));
}

NS_IMETHODIMP DesktopEmbedderCoreState::RegisterWindow(uint64_t* aWindowId) {
  return ToNsresult(navis_core_runtime_register_window(mRuntime, aWindowId));
}

NS_IMETHODIMP DesktopEmbedderCoreState::CloseWindow(uint64_t aWindowId) {
  return ToNsresult(navis_core_runtime_close_window(mRuntime, aWindowId));
}

NS_IMETHODIMP DesktopEmbedderCoreState::RegisterView(uint64_t aWindowId,
                                                     uint64_t* aViewId) {
  return ToNsresult(
      navis_core_runtime_register_view(mRuntime, aWindowId, aViewId));
}

NS_IMETHODIMP DesktopEmbedderCoreState::CreateSession(uint64_t aViewId,
                                                      uint64_t* aSessionId) {
  return ToNsresult(
      navis_core_runtime_create_session(mRuntime, aViewId, aSessionId));
}

NS_IMETHODIMP DesktopEmbedderCoreState::CreateSessionWithMode(
    uint64_t aViewId, bool aPrivateMode, uint64_t* aSessionId) {
  return ToNsresult(navis_core_runtime_create_session_with_mode(
      mRuntime, aViewId, aPrivateMode, aSessionId));
}

NS_IMETHODIMP DesktopEmbedderCoreState::IsSessionPrivate(uint64_t aSessionId,
                                                         bool* aPrivateMode) {
  return ToNsresult(navis_core_runtime_session_is_private(mRuntime, aSessionId,
                                                          aPrivateMode));
}

NS_IMETHODIMP DesktopEmbedderCoreState::ActivateSession(uint64_t aSessionId,
                                                        bool* aChanged) {
  return ToNsresult(
      navis_core_runtime_activate_session(mRuntime, aSessionId, aChanged));
}

NS_IMETHODIMP DesktopEmbedderCoreState::CloseSession(uint64_t aSessionId) {
  return ToNsresult(navis_core_runtime_close_session(mRuntime, aSessionId));
}

NS_IMETHODIMP DesktopEmbedderCoreState::CanAttach(uint64_t aSessionId,
                                                  uint64_t aViewId,
                                                  bool* aCanAttach) {
  return ToNsresult(
      navis_core_runtime_can_attach(mRuntime, aSessionId, aViewId, aCanAttach));
}

NS_IMETHODIMP DesktopEmbedderCoreState::Attach(uint64_t aSessionId,
                                               uint64_t aViewId) {
  return ToNsresult(navis_core_runtime_attach(mRuntime, aSessionId, aViewId));
}

NS_IMETHODIMP DesktopEmbedderCoreState::Detach(uint64_t aSessionId,
                                               uint64_t aViewId) {
  return ToNsresult(navis_core_runtime_detach(mRuntime, aSessionId, aViewId));
}

NS_IMETHODIMP DesktopEmbedderCoreState::SetCrashed(uint64_t aSessionId,
                                                   bool aCrashed) {
  return ToNsresult(
      navis_core_runtime_set_crashed(mRuntime, aSessionId, aCrashed));
}

NS_IMETHODIMP DesktopEmbedderCoreState::BeginNavigation(
    uint64_t aSessionId, uint32_t aCommand, const nsACString& aRequestedUrl,
    bool aHasRequestedUrl, uint64_t* aNavigationId) {
  const auto* url =
      reinterpret_cast<const uint8_t*>(aRequestedUrl.BeginReading());
  return ToNsresult(navis_core_runtime_begin_navigation(
      mRuntime, aSessionId, aCommand, aHasRequestedUrl ? url : nullptr,
      aHasRequestedUrl ? aRequestedUrl.Length() : 0, aHasRequestedUrl,
      aNavigationId));
}

NS_IMETHODIMP DesktopEmbedderCoreState::ObserveNavigationStart(
    uint64_t aSessionId, const nsACString& aRequestedUrl, bool aHasRequestedUrl,
    uint32_t aStartKind, uint64_t* aNavigationId) {
  const auto* url =
      reinterpret_cast<const uint8_t*>(aRequestedUrl.BeginReading());
  return ToNsresult(navis_core_runtime_observe_navigation_start(
      mRuntime, aSessionId, aHasRequestedUrl ? url : nullptr,
      aHasRequestedUrl ? aRequestedUrl.Length() : 0, aHasRequestedUrl,
      aStartKind, aNavigationId));
}

NS_IMETHODIMP DesktopEmbedderCoreState::SetNavigationLocation(
    uint64_t aSessionId, uint64_t aNavigationId, const nsACString& aUrl,
    bool* aChanged) {
  return ToNsresult(navis_core_runtime_set_navigation_location(
      mRuntime, aSessionId, aNavigationId,
      reinterpret_cast<const uint8_t*>(aUrl.BeginReading()), aUrl.Length(),
      aChanged));
}

NS_IMETHODIMP DesktopEmbedderCoreState::SetNavigationTitle(
    uint64_t aSessionId, uint64_t aNavigationId, const nsACString& aTitle,
    bool* aChanged) {
  return ToNsresult(navis_core_runtime_set_navigation_title(
      mRuntime, aSessionId, aNavigationId,
      reinterpret_cast<const uint8_t*>(aTitle.BeginReading()), aTitle.Length(),
      aChanged));
}

NS_IMETHODIMP DesktopEmbedderCoreState::SetNavigationSecurity(
    uint64_t aSessionId, uint64_t aNavigationId, uint32_t aSecurity,
    bool* aChanged) {
  return ToNsresult(navis_core_runtime_set_navigation_security(
      mRuntime, aSessionId, aNavigationId, aSecurity, aChanged));
}

NS_IMETHODIMP DesktopEmbedderCoreState::SetNavigationIdentity(
    uint64_t aSessionId, uint64_t aNavigationId, uint32_t aIdentity,
    const nsACString& aIdentityKey, bool* aChanged) {
  return ToNsresult(navis_core_runtime_set_navigation_identity(
      mRuntime, aSessionId, aNavigationId, aIdentity,
      reinterpret_cast<const uint8_t*>(aIdentityKey.BeginReading()),
      aIdentityKey.Length(), aChanged));
}

NS_IMETHODIMP DesktopEmbedderCoreState::SetNavigationHistory(
    uint64_t aSessionId, uint64_t aNavigationId, bool aCanGoBack,
    bool aCanGoForward, bool* aChanged) {
  return ToNsresult(navis_core_runtime_set_navigation_history(
      mRuntime, aSessionId, aNavigationId, aCanGoBack, aCanGoForward,
      aChanged));
}

NS_IMETHODIMP DesktopEmbedderCoreState::FinishNavigation(uint64_t aSessionId,
                                                         uint64_t aNavigationId,
                                                         bool aHasFailure,
                                                         uint32_t aFailureCode,
                                                         bool* aChanged) {
  return ToNsresult(navis_core_runtime_finish_navigation(
      mRuntime, aSessionId, aNavigationId, aHasFailure, aFailureCode,
      aChanged));
}

NS_IMETHODIMP DesktopEmbedderCoreState::StopNavigation(uint64_t aSessionId,
                                                       uint64_t aNavigationId,
                                                       bool* aChanged) {
  return ToNsresult(navis_core_runtime_stop_navigation(
      mRuntime, aSessionId, aNavigationId, aChanged));
}

NS_IMETHODIMP DesktopEmbedderCoreState::NavigationState(
    uint64_t aSessionId, nsIDesktopEmbedderNavigationState** aState) {
  NavisCoreNavigationSnapshot snapshot{};
  nsresult result = ToNsresult(
      navis_core_runtime_navigation_snapshot(mRuntime, aSessionId, &snapshot));
  if (NS_FAILED(result)) {
    return result;
  }
  if (snapshot.url_length > std::numeric_limits<uint32_t>::max() ||
      snapshot.title_length > std::numeric_limits<uint32_t>::max() ||
      snapshot.identity_key_length > std::numeric_limits<uint32_t>::max()) {
    return NS_ERROR_FILE_TOO_BIG;
  }
  RefPtr<DesktopEmbedderNavigationState> state =
      new DesktopEmbedderNavigationState(snapshot);
  state.forget(aState);
  return NS_OK;
}

NS_IMETHODIMP DesktopEmbedderCoreState::AssertConsistent() {
  return ToNsresult(navis_core_runtime_check_invariants(mRuntime));
}

NS_IMETHODIMP DesktopEmbedderCoreState::Shutdown(bool* aChanged) {
  return ToNsresult(navis_core_runtime_shutdown(mRuntime, aChanged));
}

}  // namespace mozilla::desktop
