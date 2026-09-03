/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef NavisCoreFFI_h
#define NavisCoreFFI_h

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

struct NavisCoreRuntime;

struct NavisCoreNavigationSnapshot {
  uint64_t revision;
  uint64_t navigation_id;
  const uint8_t *url;
  size_t url_length;
  const uint8_t *title;
  size_t title_length;
  uint32_t activity;
  uint32_t security;
  uint32_t identity;
  const uint8_t *identity_key;
  size_t identity_key_length;
  bool can_go_back;
  bool can_go_forward;
  bool has_failure;
  uint32_t failure_code;
};

enum NavisCoreStatus : uint32_t {
  NAVIS_CORE_OK = 0,
  NAVIS_CORE_NULL_POINTER = 1,
  NAVIS_CORE_CLOSED = 2,
  NAVIS_CORE_UNKNOWN_WINDOW = 3,
  NAVIS_CORE_UNKNOWN_VIEW = 4,
  NAVIS_CORE_UNKNOWN_SESSION = 5,
  NAVIS_CORE_CONFLICT = 6,
  NAVIS_CORE_INVARIANT_VIOLATION = 7,
  NAVIS_CORE_IDENTIFIER_EXHAUSTED = 8,
  NAVIS_CORE_INVALID_ARGUMENT = 9,
};

enum NavisCoreNavigationCommand : uint32_t {
  NAVIS_CORE_NAVIGATION_LOAD = 0,
  NAVIS_CORE_NAVIGATION_RELOAD = 1,
  NAVIS_CORE_NAVIGATION_BACK = 2,
  NAVIS_CORE_NAVIGATION_FORWARD = 3,
  NAVIS_CORE_NAVIGATION_RESTORE = 4,
};

enum NavisCoreNavigationStartKind : uint32_t {
  NAVIS_CORE_NAVIGATION_START_STANDARD = 0,
  NAVIS_CORE_NAVIGATION_START_INTERNAL_PAGE = 1,
};

enum NavisCoreNavigationActivity : uint32_t {
  NAVIS_CORE_NAVIGATION_ACTIVITY_IDLE = 0,
  NAVIS_CORE_NAVIGATION_ACTIVITY_PENDING = 1,
  NAVIS_CORE_NAVIGATION_ACTIVITY_VISIBLE = 2,
  NAVIS_CORE_NAVIGATION_ACTIVITY_SILENT = 3,
};

enum NavisCoreNavigationSecurity : uint32_t {
  NAVIS_CORE_SECURITY_UNKNOWN = 0,
  NAVIS_CORE_SECURITY_INSECURE = 1,
  NAVIS_CORE_SECURITY_BROKEN = 2,
  NAVIS_CORE_SECURITY_SECURE = 3,
};

enum NavisCoreNavigationIdentity : uint32_t {
  NAVIS_CORE_IDENTITY_UNKNOWN = 0,
  NAVIS_CORE_IDENTITY_WEB = 1,
  NAVIS_CORE_IDENTITY_INTERNAL_PAGE = 2,
  NAVIS_CORE_IDENTITY_BUILT_IN_EXTENSION = 3,
  NAVIS_CORE_IDENTITY_INTERNAL_ERROR = 4,
};

extern "C" {
NavisCoreRuntime *navis_core_runtime_new();
void navis_core_runtime_free(NavisCoreRuntime *runtime);
NavisCoreStatus navis_core_runtime_is_closed(const NavisCoreRuntime *runtime,
                                             bool *output);
NavisCoreStatus navis_core_runtime_window_count(const NavisCoreRuntime *runtime,
                                                uint64_t *output);
NavisCoreStatus
navis_core_runtime_session_count(const NavisCoreRuntime *runtime,
                                 uint64_t *output);
NavisCoreStatus navis_core_runtime_register_window(NavisCoreRuntime *runtime,
                                                   uint64_t *output);
NavisCoreStatus navis_core_runtime_close_window(NavisCoreRuntime *runtime,
                                                uint64_t window);
NavisCoreStatus navis_core_runtime_register_view(NavisCoreRuntime *runtime,
                                                 uint64_t window,
                                                 uint64_t *output);
NavisCoreStatus navis_core_runtime_create_session(NavisCoreRuntime *runtime,
                                                  uint64_t view,
                                                  uint64_t *output);
NavisCoreStatus navis_core_runtime_create_session_with_mode(
    NavisCoreRuntime *runtime, uint64_t view, bool private_mode,
    uint64_t *output);
NavisCoreStatus navis_core_runtime_session_is_private(
    const NavisCoreRuntime *runtime, uint64_t session, bool *output);
NavisCoreStatus navis_core_runtime_activate_session(NavisCoreRuntime *runtime,
                                                    uint64_t session,
                                                    bool *changed);
NavisCoreStatus navis_core_runtime_close_session(NavisCoreRuntime *runtime,
                                                 uint64_t session);
NavisCoreStatus navis_core_runtime_can_attach(const NavisCoreRuntime *runtime,
                                              uint64_t session, uint64_t view,
                                              bool *output);
NavisCoreStatus navis_core_runtime_attach(NavisCoreRuntime *runtime,
                                          uint64_t session, uint64_t view);
NavisCoreStatus navis_core_runtime_detach(NavisCoreRuntime *runtime,
                                          uint64_t session, uint64_t view);
NavisCoreStatus navis_core_runtime_set_crashed(NavisCoreRuntime *runtime,
                                               uint64_t session, bool crashed);
NavisCoreStatus navis_core_runtime_begin_navigation(
    NavisCoreRuntime *runtime, uint64_t session, uint32_t command,
    const uint8_t *requested_url, size_t requested_url_length,
    bool has_requested_url, uint64_t *output);
NavisCoreStatus navis_core_runtime_observe_navigation_start(
    NavisCoreRuntime *runtime, uint64_t session, const uint8_t *requested_url,
    size_t requested_url_length, bool has_requested_url,
    uint32_t start_kind, uint64_t *output);
NavisCoreStatus navis_core_runtime_set_navigation_location(
    NavisCoreRuntime *runtime, uint64_t session, uint64_t navigation,
    const uint8_t *url, size_t url_length, bool *changed);
NavisCoreStatus navis_core_runtime_set_navigation_title(
    NavisCoreRuntime *runtime, uint64_t session, uint64_t navigation,
    const uint8_t *title, size_t title_length, bool *changed);
NavisCoreStatus navis_core_runtime_set_navigation_security(
    NavisCoreRuntime *runtime, uint64_t session, uint64_t navigation,
    uint32_t security, bool *changed);
NavisCoreStatus navis_core_runtime_set_navigation_identity(
    NavisCoreRuntime *runtime, uint64_t session, uint64_t navigation,
    uint32_t identity, const uint8_t *identity_key,
    size_t identity_key_length, bool *changed);
NavisCoreStatus navis_core_runtime_set_navigation_history(
    NavisCoreRuntime *runtime, uint64_t session, uint64_t navigation,
    bool can_go_back, bool can_go_forward, bool *changed);
NavisCoreStatus navis_core_runtime_finish_navigation(
    NavisCoreRuntime *runtime, uint64_t session, uint64_t navigation,
    bool has_failure, uint32_t failure_code, bool *changed);
NavisCoreStatus navis_core_runtime_stop_navigation(
    NavisCoreRuntime *runtime, uint64_t session, uint64_t navigation,
    bool *changed);
// String pointers in this borrowed snapshot remain valid until the next
// snapshot call or runtime destruction. The caller must copy them immediately.
NavisCoreStatus navis_core_runtime_navigation_snapshot(
    NavisCoreRuntime *runtime, uint64_t session,
    NavisCoreNavigationSnapshot *output);
NavisCoreStatus
navis_core_runtime_check_invariants(const NavisCoreRuntime *runtime);
NavisCoreStatus navis_core_runtime_shutdown(NavisCoreRuntime *runtime,
                                            bool *changed);
}

#endif // NavisCoreFFI_h
