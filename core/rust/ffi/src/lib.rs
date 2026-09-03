/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use navis_core::{
    CoreError, NavigationActivity, NavigationCommand, NavigationId, NavigationIdentity,
    NavigationSecurity, NavigationSnapshot, NavigationStartKind, Runtime, SessionId, ViewId,
    WindowId,
};
use std::{ptr, slice, str};

#[repr(C)]
pub struct NavisCoreRuntime {
    runtime: Runtime,
    navigation_snapshot: Option<NavigationSnapshot>,
}

#[repr(C)]
pub struct NavisCoreNavigationSnapshot {
    pub revision: u64,
    pub navigation_id: u64,
    pub url: *const u8,
    pub url_length: usize,
    pub title: *const u8,
    pub title_length: usize,
    pub activity: u32,
    pub security: u32,
    pub identity: u32,
    pub identity_key: *const u8,
    pub identity_key_length: usize,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub has_failure: bool,
    pub failure_code: u32,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NavisCoreStatus {
    Ok = 0,
    NullPointer = 1,
    Closed = 2,
    UnknownWindow = 3,
    UnknownView = 4,
    UnknownSession = 5,
    Conflict = 6,
    InvariantViolation = 7,
    IdentifierExhausted = 8,
    InvalidArgument = 9,
}

// Keep the Rust half of the private Core ABI explicit on every compiled
// 64-bit target. The C++ header is checked independently by
// scripts/verify-core-abi.py.
const _: () = {
    assert!(std::mem::size_of::<NavisCoreStatus>() == 4);
    assert!(NavisCoreStatus::Ok as u32 == 0);
    assert!(NavisCoreStatus::NullPointer as u32 == 1);
    assert!(NavisCoreStatus::Closed as u32 == 2);
    assert!(NavisCoreStatus::UnknownWindow as u32 == 3);
    assert!(NavisCoreStatus::UnknownView as u32 == 4);
    assert!(NavisCoreStatus::UnknownSession as u32 == 5);
    assert!(NavisCoreStatus::Conflict as u32 == 6);
    assert!(NavisCoreStatus::InvariantViolation as u32 == 7);
    assert!(NavisCoreStatus::IdentifierExhausted as u32 == 8);
    assert!(NavisCoreStatus::InvalidArgument as u32 == 9);

    assert!(std::mem::align_of::<NavisCoreNavigationSnapshot>() == 8);
    assert!(std::mem::size_of::<NavisCoreNavigationSnapshot>() == 88);
    assert!(std::mem::offset_of!(NavisCoreNavigationSnapshot, revision) == 0);
    assert!(std::mem::offset_of!(NavisCoreNavigationSnapshot, navigation_id) == 8);
    assert!(std::mem::offset_of!(NavisCoreNavigationSnapshot, url) == 16);
    assert!(std::mem::offset_of!(NavisCoreNavigationSnapshot, url_length) == 24);
    assert!(std::mem::offset_of!(NavisCoreNavigationSnapshot, title) == 32);
    assert!(std::mem::offset_of!(NavisCoreNavigationSnapshot, title_length) == 40);
    assert!(std::mem::offset_of!(NavisCoreNavigationSnapshot, activity) == 48);
    assert!(std::mem::offset_of!(NavisCoreNavigationSnapshot, security) == 52);
    assert!(std::mem::offset_of!(NavisCoreNavigationSnapshot, identity) == 56);
    assert!(std::mem::offset_of!(NavisCoreNavigationSnapshot, identity_key) == 64);
    assert!(std::mem::offset_of!(NavisCoreNavigationSnapshot, identity_key_length) == 72);
    assert!(std::mem::offset_of!(NavisCoreNavigationSnapshot, can_go_back) == 80);
    assert!(std::mem::offset_of!(NavisCoreNavigationSnapshot, can_go_forward) == 81);
    assert!(std::mem::offset_of!(NavisCoreNavigationSnapshot, has_failure) == 82);
    assert!(std::mem::offset_of!(NavisCoreNavigationSnapshot, failure_code) == 84);
};

impl From<CoreError> for NavisCoreStatus {
    fn from(error: CoreError) -> Self {
        match error {
            CoreError::Closed => Self::Closed,
            CoreError::UnknownWindow => Self::UnknownWindow,
            CoreError::UnknownView => Self::UnknownView,
            CoreError::UnknownSession => Self::UnknownSession,
            CoreError::IdentifierExhausted => Self::IdentifierExhausted,
            CoreError::InvariantViolation => Self::InvariantViolation,
            CoreError::InvalidArgument => Self::InvalidArgument,
            CoreError::WindowHasSessions
            | CoreError::ViewAlreadyBound
            | CoreError::SessionAlreadyAttached
            | CoreError::SessionDetached
            | CoreError::BindingMismatch
            | CoreError::NavigationNotAllowed => Self::Conflict,
        }
    }
}

unsafe fn runtime_mut<'a>(
    value: *mut NavisCoreRuntime,
) -> Result<&'a mut Runtime, NavisCoreStatus> {
    value
        .as_mut()
        .map(|value| &mut value.runtime)
        .ok_or(NavisCoreStatus::NullPointer)
}

unsafe fn holder_mut<'a>(
    value: *mut NavisCoreRuntime,
) -> Result<&'a mut NavisCoreRuntime, NavisCoreStatus> {
    value.as_mut().ok_or(NavisCoreStatus::NullPointer)
}

unsafe fn runtime_ref<'a>(value: *const NavisCoreRuntime) -> Result<&'a Runtime, NavisCoreStatus> {
    value
        .as_ref()
        .map(|value| &value.runtime)
        .ok_or(NavisCoreStatus::NullPointer)
}

unsafe fn write<T>(output: *mut T, value: T) -> Result<(), NavisCoreStatus> {
    if output.is_null() {
        return Err(NavisCoreStatus::NullPointer);
    }
    ptr::write(output, value);
    Ok(())
}

fn status(result: Result<(), CoreError>) -> NavisCoreStatus {
    result.map_or_else(Into::into, |_| NavisCoreStatus::Ok)
}

fn navigation_command(value: u32) -> Result<NavigationCommand, NavisCoreStatus> {
    match value {
        0 => Ok(NavigationCommand::Load),
        1 => Ok(NavigationCommand::Reload),
        2 => Ok(NavigationCommand::Back),
        3 => Ok(NavigationCommand::Forward),
        4 => Ok(NavigationCommand::Restore),
        _ => Err(NavisCoreStatus::InvalidArgument),
    }
}

fn navigation_start_kind(value: u32) -> Result<NavigationStartKind, NavisCoreStatus> {
    match value {
        0 => Ok(NavigationStartKind::Standard),
        1 => Ok(NavigationStartKind::InternalPage),
        _ => Err(NavisCoreStatus::InvalidArgument),
    }
}

fn navigation_activity_value(value: NavigationActivity) -> u32 {
    match value {
        NavigationActivity::Idle => 0,
        NavigationActivity::Pending => 1,
        NavigationActivity::Visible => 2,
        NavigationActivity::Silent => 3,
    }
}

fn navigation_security(value: u32) -> Result<NavigationSecurity, NavisCoreStatus> {
    match value {
        0 => Ok(NavigationSecurity::Unknown),
        1 => Ok(NavigationSecurity::Insecure),
        2 => Ok(NavigationSecurity::Broken),
        3 => Ok(NavigationSecurity::Secure),
        _ => Err(NavisCoreStatus::InvalidArgument),
    }
}

fn navigation_security_value(value: NavigationSecurity) -> u32 {
    match value {
        NavigationSecurity::Unknown => 0,
        NavigationSecurity::Insecure => 1,
        NavigationSecurity::Broken => 2,
        NavigationSecurity::Secure => 3,
    }
}

fn navigation_identity(value: u32) -> Result<NavigationIdentity, NavisCoreStatus> {
    match value {
        0 => Ok(NavigationIdentity::Unknown),
        1 => Ok(NavigationIdentity::Web),
        2 => Ok(NavigationIdentity::InternalPage),
        3 => Ok(NavigationIdentity::BuiltInExtension),
        4 => Ok(NavigationIdentity::InternalError),
        _ => Err(NavisCoreStatus::InvalidArgument),
    }
}

fn navigation_identity_value(value: NavigationIdentity) -> u32 {
    match value {
        NavigationIdentity::Unknown => 0,
        NavigationIdentity::Web => 1,
        NavigationIdentity::InternalPage => 2,
        NavigationIdentity::BuiltInExtension => 3,
        NavigationIdentity::InternalError => 4,
    }
}

unsafe fn input_string<'a>(value: *const u8, length: usize) -> Result<&'a str, NavisCoreStatus> {
    if length == 0 {
        return Ok("");
    }
    if value.is_null() {
        return Err(NavisCoreStatus::NullPointer);
    }
    str::from_utf8(slice::from_raw_parts(value, length))
        .map_err(|_| NavisCoreStatus::InvalidArgument)
}

#[no_mangle]
pub extern "C" fn navis_core_runtime_new() -> *mut NavisCoreRuntime {
    Box::into_raw(Box::new(NavisCoreRuntime {
        runtime: Runtime::new(),
        navigation_snapshot: None,
    }))
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_free(runtime: *mut NavisCoreRuntime) {
    if !runtime.is_null() {
        drop(Box::from_raw(runtime));
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_is_closed(
    runtime: *const NavisCoreRuntime,
    output: *mut bool,
) -> NavisCoreStatus {
    match runtime_ref(runtime).and_then(|runtime| write(output, runtime.is_closed())) {
        Ok(()) => NavisCoreStatus::Ok,
        Err(error) => error,
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_window_count(
    runtime: *const NavisCoreRuntime,
    output: *mut u64,
) -> NavisCoreStatus {
    match runtime_ref(runtime).and_then(|runtime| write(output, runtime.window_count() as u64)) {
        Ok(()) => NavisCoreStatus::Ok,
        Err(error) => error,
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_session_count(
    runtime: *const NavisCoreRuntime,
    output: *mut u64,
) -> NavisCoreStatus {
    match runtime_ref(runtime).and_then(|runtime| write(output, runtime.session_count() as u64)) {
        Ok(()) => NavisCoreStatus::Ok,
        Err(error) => error,
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_register_window(
    runtime: *mut NavisCoreRuntime,
    output: *mut u64,
) -> NavisCoreStatus {
    match runtime_mut(runtime)
        .and_then(|runtime| runtime.register_window().map_err(Into::into))
        .and_then(|id| write(output, id.get()))
    {
        Ok(()) => NavisCoreStatus::Ok,
        Err(error) => error,
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_close_window(
    runtime: *mut NavisCoreRuntime,
    window: u64,
) -> NavisCoreStatus {
    match runtime_mut(runtime) {
        Ok(runtime) => status(runtime.close_window(WindowId::from_raw(window))),
        Err(error) => error,
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_register_view(
    runtime: *mut NavisCoreRuntime,
    window: u64,
    output: *mut u64,
) -> NavisCoreStatus {
    match runtime_mut(runtime)
        .and_then(|runtime| {
            runtime
                .register_view(WindowId::from_raw(window))
                .map_err(Into::into)
        })
        .and_then(|id| write(output, id.get()))
    {
        Ok(()) => NavisCoreStatus::Ok,
        Err(error) => error,
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_create_session(
    runtime: *mut NavisCoreRuntime,
    view: u64,
    output: *mut u64,
) -> NavisCoreStatus {
    match runtime_mut(runtime)
        .and_then(|runtime| {
            runtime
                .create_session(ViewId::from_raw(view))
                .map_err(Into::into)
        })
        .and_then(|id| write(output, id.get()))
    {
        Ok(()) => NavisCoreStatus::Ok,
        Err(error) => error,
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_create_session_with_mode(
    runtime: *mut NavisCoreRuntime,
    view: u64,
    private: bool,
    output: *mut u64,
) -> NavisCoreStatus {
    match runtime_mut(runtime)
        .and_then(|runtime| {
            runtime
                .create_session_with_mode(ViewId::from_raw(view), private)
                .map_err(Into::into)
        })
        .and_then(|id| write(output, id.get()))
    {
        Ok(()) => NavisCoreStatus::Ok,
        Err(error) => error,
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_session_is_private(
    runtime: *const NavisCoreRuntime,
    session: u64,
    output: *mut bool,
) -> NavisCoreStatus {
    match runtime_ref(runtime)
        .and_then(|runtime| {
            runtime
                .session_is_private(SessionId::from_raw(session))
                .map_err(Into::into)
        })
        .and_then(|value| write(output, value))
    {
        Ok(()) => NavisCoreStatus::Ok,
        Err(error) => error,
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_activate_session(
    runtime: *mut NavisCoreRuntime,
    session: u64,
    changed: *mut bool,
) -> NavisCoreStatus {
    match runtime_mut(runtime)
        .and_then(|runtime| {
            runtime
                .activate_session(SessionId::from_raw(session))
                .map_err(Into::into)
        })
        .and_then(|value| write(changed, value))
    {
        Ok(()) => NavisCoreStatus::Ok,
        Err(error) => error,
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_close_session(
    runtime: *mut NavisCoreRuntime,
    session: u64,
) -> NavisCoreStatus {
    match runtime_mut(runtime) {
        Ok(runtime) => status(runtime.close_session(SessionId::from_raw(session))),
        Err(error) => error,
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_can_attach(
    runtime: *const NavisCoreRuntime,
    session: u64,
    view: u64,
    output: *mut bool,
) -> NavisCoreStatus {
    match runtime_ref(runtime)
        .and_then(|runtime| {
            runtime
                .can_attach(SessionId::from_raw(session), ViewId::from_raw(view))
                .map_err(Into::into)
        })
        .and_then(|value| write(output, value))
    {
        Ok(()) => NavisCoreStatus::Ok,
        Err(error) => error,
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_attach(
    runtime: *mut NavisCoreRuntime,
    session: u64,
    view: u64,
) -> NavisCoreStatus {
    match runtime_mut(runtime) {
        Ok(runtime) => status(runtime.attach(SessionId::from_raw(session), ViewId::from_raw(view))),
        Err(error) => error,
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_detach(
    runtime: *mut NavisCoreRuntime,
    session: u64,
    view: u64,
) -> NavisCoreStatus {
    match runtime_mut(runtime) {
        Ok(runtime) => status(runtime.detach(SessionId::from_raw(session), ViewId::from_raw(view))),
        Err(error) => error,
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_set_crashed(
    runtime: *mut NavisCoreRuntime,
    session: u64,
    crashed: bool,
) -> NavisCoreStatus {
    match runtime_mut(runtime) {
        Ok(runtime) => status(runtime.set_crashed(SessionId::from_raw(session), crashed)),
        Err(error) => error,
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_begin_navigation(
    runtime: *mut NavisCoreRuntime,
    session: u64,
    command: u32,
    requested_url: *const u8,
    requested_url_length: usize,
    has_requested_url: bool,
    output: *mut u64,
) -> NavisCoreStatus {
    let result = runtime_mut(runtime)
        .and_then(|runtime| {
            let command = navigation_command(command)?;
            let requested_url = if has_requested_url {
                Some(input_string(requested_url, requested_url_length)?)
            } else {
                None
            };
            runtime
                .begin_navigation(SessionId::from_raw(session), command, requested_url)
                .map_err(Into::into)
        })
        .and_then(|navigation| write(output, navigation.get()));
    result.map_or_else(|error| error, |_| NavisCoreStatus::Ok)
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_observe_navigation_start(
    runtime: *mut NavisCoreRuntime,
    session: u64,
    requested_url: *const u8,
    requested_url_length: usize,
    has_requested_url: bool,
    start_kind: u32,
    output: *mut u64,
) -> NavisCoreStatus {
    let result = runtime_mut(runtime)
        .and_then(|runtime| {
            let requested_url = if has_requested_url {
                Some(input_string(requested_url, requested_url_length)?)
            } else {
                None
            };
            let start_kind = navigation_start_kind(start_kind)?;
            runtime
                .observe_navigation_start(SessionId::from_raw(session), requested_url, start_kind)
                .map_err(Into::into)
        })
        .and_then(|navigation| write(output, navigation.get()));
    result.map_or_else(|error| error, |_| NavisCoreStatus::Ok)
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_set_navigation_location(
    runtime: *mut NavisCoreRuntime,
    session: u64,
    navigation: u64,
    url: *const u8,
    url_length: usize,
    changed: *mut bool,
) -> NavisCoreStatus {
    let result = runtime_mut(runtime)
        .and_then(|runtime| {
            let url = input_string(url, url_length)?;
            runtime
                .set_navigation_location(
                    SessionId::from_raw(session),
                    NavigationId::from_raw(navigation),
                    url,
                )
                .map_err(Into::into)
        })
        .and_then(|value| write(changed, value));
    result.map_or_else(|error| error, |_| NavisCoreStatus::Ok)
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_set_navigation_title(
    runtime: *mut NavisCoreRuntime,
    session: u64,
    navigation: u64,
    title: *const u8,
    title_length: usize,
    changed: *mut bool,
) -> NavisCoreStatus {
    let result = runtime_mut(runtime)
        .and_then(|runtime| {
            let title = input_string(title, title_length)?;
            runtime
                .set_navigation_title(
                    SessionId::from_raw(session),
                    NavigationId::from_raw(navigation),
                    title,
                )
                .map_err(Into::into)
        })
        .and_then(|value| write(changed, value));
    result.map_or_else(|error| error, |_| NavisCoreStatus::Ok)
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_set_navigation_security(
    runtime: *mut NavisCoreRuntime,
    session: u64,
    navigation: u64,
    security: u32,
    changed: *mut bool,
) -> NavisCoreStatus {
    let result = runtime_mut(runtime)
        .and_then(|runtime| {
            let security = navigation_security(security)?;
            runtime
                .set_navigation_security(
                    SessionId::from_raw(session),
                    NavigationId::from_raw(navigation),
                    security,
                )
                .map_err(Into::into)
        })
        .and_then(|value| write(changed, value));
    result.map_or_else(|error| error, |_| NavisCoreStatus::Ok)
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_set_navigation_identity(
    runtime: *mut NavisCoreRuntime,
    session: u64,
    navigation: u64,
    identity: u32,
    identity_key: *const u8,
    identity_key_length: usize,
    changed: *mut bool,
) -> NavisCoreStatus {
    let result = runtime_mut(runtime)
        .and_then(|runtime| {
            let identity = navigation_identity(identity)?;
            let identity_key = input_string(identity_key, identity_key_length)?;
            runtime
                .set_navigation_identity(
                    SessionId::from_raw(session),
                    NavigationId::from_raw(navigation),
                    identity,
                    identity_key,
                )
                .map_err(Into::into)
        })
        .and_then(|value| write(changed, value));
    result.map_or_else(|error| error, |_| NavisCoreStatus::Ok)
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_set_navigation_history(
    runtime: *mut NavisCoreRuntime,
    session: u64,
    navigation: u64,
    can_go_back: bool,
    can_go_forward: bool,
    changed: *mut bool,
) -> NavisCoreStatus {
    let result = runtime_mut(runtime)
        .and_then(|runtime| {
            runtime
                .set_navigation_history(
                    SessionId::from_raw(session),
                    NavigationId::from_raw(navigation),
                    can_go_back,
                    can_go_forward,
                )
                .map_err(Into::into)
        })
        .and_then(|value| write(changed, value));
    result.map_or_else(|error| error, |_| NavisCoreStatus::Ok)
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_finish_navigation(
    runtime: *mut NavisCoreRuntime,
    session: u64,
    navigation: u64,
    has_failure: bool,
    failure_code: u32,
    changed: *mut bool,
) -> NavisCoreStatus {
    let result = runtime_mut(runtime)
        .and_then(|runtime| {
            runtime
                .finish_navigation(
                    SessionId::from_raw(session),
                    NavigationId::from_raw(navigation),
                    has_failure.then_some(failure_code),
                )
                .map_err(Into::into)
        })
        .and_then(|value| write(changed, value));
    result.map_or_else(|error| error, |_| NavisCoreStatus::Ok)
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_stop_navigation(
    runtime: *mut NavisCoreRuntime,
    session: u64,
    navigation: u64,
    changed: *mut bool,
) -> NavisCoreStatus {
    let result = runtime_mut(runtime)
        .and_then(|runtime| {
            runtime
                .stop_navigation(
                    SessionId::from_raw(session),
                    NavigationId::from_raw(navigation),
                )
                .map_err(Into::into)
        })
        .and_then(|value| write(changed, value));
    result.map_or_else(|error| error, |_| NavisCoreStatus::Ok)
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_navigation_snapshot(
    runtime: *mut NavisCoreRuntime,
    session: u64,
    output: *mut NavisCoreNavigationSnapshot,
) -> NavisCoreStatus {
    if output.is_null() {
        return NavisCoreStatus::NullPointer;
    }
    let runtime = match holder_mut(runtime) {
        Ok(runtime) => runtime,
        Err(error) => return error,
    };
    let snapshot = match runtime
        .runtime
        .navigation_snapshot(SessionId::from_raw(session))
    {
        Ok(snapshot) => snapshot,
        Err(error) => return error.into(),
    };
    runtime.navigation_snapshot = Some(snapshot);
    let snapshot = runtime
        .navigation_snapshot
        .as_ref()
        .expect("navigation snapshot was just stored");
    let value = NavisCoreNavigationSnapshot {
        revision: snapshot.revision,
        navigation_id: snapshot.navigation_id.get(),
        url: snapshot.url.as_ptr(),
        url_length: snapshot.url.len(),
        title: snapshot.title.as_ptr(),
        title_length: snapshot.title.len(),
        activity: navigation_activity_value(snapshot.activity),
        security: navigation_security_value(snapshot.security),
        identity: navigation_identity_value(snapshot.identity),
        identity_key: snapshot.identity_key.as_ptr(),
        identity_key_length: snapshot.identity_key.len(),
        can_go_back: snapshot.can_go_back,
        can_go_forward: snapshot.can_go_forward,
        has_failure: snapshot.failure_code.is_some(),
        failure_code: snapshot.failure_code.unwrap_or(0),
    };
    ptr::write(output, value);
    NavisCoreStatus::Ok
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_check_invariants(
    runtime: *const NavisCoreRuntime,
) -> NavisCoreStatus {
    match runtime_ref(runtime) {
        Ok(runtime) => status(runtime.check_invariants()),
        Err(error) => error,
    }
}

#[no_mangle]
pub unsafe extern "C" fn navis_core_runtime_shutdown(
    runtime: *mut NavisCoreRuntime,
    changed: *mut bool,
) -> NavisCoreStatus {
    match runtime_mut(runtime)
        .and_then(|runtime| runtime.shutdown().map_err(Into::into))
        .and_then(|value| write(changed, value))
    {
        Ok(()) => NavisCoreStatus::Ok,
        Err(error) => error,
    }
}

// These assignments make every exported Rust signature part of the compiled
// ABI contract. The independent C++ probe pins the matching header types.
const _: extern "C" fn() -> *mut NavisCoreRuntime = navis_core_runtime_new;
const _: unsafe extern "C" fn(*mut NavisCoreRuntime) = navis_core_runtime_free;
const _: unsafe extern "C" fn(*const NavisCoreRuntime, *mut bool) -> NavisCoreStatus =
    navis_core_runtime_is_closed;
const _: unsafe extern "C" fn(*const NavisCoreRuntime, *mut u64) -> NavisCoreStatus =
    navis_core_runtime_window_count;
const _: unsafe extern "C" fn(*const NavisCoreRuntime, *mut u64) -> NavisCoreStatus =
    navis_core_runtime_session_count;
const _: unsafe extern "C" fn(*mut NavisCoreRuntime, *mut u64) -> NavisCoreStatus =
    navis_core_runtime_register_window;
const _: unsafe extern "C" fn(*mut NavisCoreRuntime, u64) -> NavisCoreStatus =
    navis_core_runtime_close_window;
const _: unsafe extern "C" fn(*mut NavisCoreRuntime, u64, *mut u64) -> NavisCoreStatus =
    navis_core_runtime_register_view;
const _: unsafe extern "C" fn(*mut NavisCoreRuntime, u64, *mut u64) -> NavisCoreStatus =
    navis_core_runtime_create_session;
const _: unsafe extern "C" fn(*mut NavisCoreRuntime, u64, bool, *mut u64) -> NavisCoreStatus =
    navis_core_runtime_create_session_with_mode;
const _: unsafe extern "C" fn(*const NavisCoreRuntime, u64, *mut bool) -> NavisCoreStatus =
    navis_core_runtime_session_is_private;
const _: unsafe extern "C" fn(*mut NavisCoreRuntime, u64, *mut bool) -> NavisCoreStatus =
    navis_core_runtime_activate_session;
const _: unsafe extern "C" fn(*mut NavisCoreRuntime, u64) -> NavisCoreStatus =
    navis_core_runtime_close_session;
const _: unsafe extern "C" fn(*const NavisCoreRuntime, u64, u64, *mut bool) -> NavisCoreStatus =
    navis_core_runtime_can_attach;
const _: unsafe extern "C" fn(*mut NavisCoreRuntime, u64, u64) -> NavisCoreStatus =
    navis_core_runtime_attach;
const _: unsafe extern "C" fn(*mut NavisCoreRuntime, u64, u64) -> NavisCoreStatus =
    navis_core_runtime_detach;
const _: unsafe extern "C" fn(*mut NavisCoreRuntime, u64, bool) -> NavisCoreStatus =
    navis_core_runtime_set_crashed;
const _: unsafe extern "C" fn(
    *mut NavisCoreRuntime,
    u64,
    u32,
    *const u8,
    usize,
    bool,
    *mut u64,
) -> NavisCoreStatus = navis_core_runtime_begin_navigation;
const _: unsafe extern "C" fn(
    *mut NavisCoreRuntime,
    u64,
    *const u8,
    usize,
    bool,
    u32,
    *mut u64,
) -> NavisCoreStatus = navis_core_runtime_observe_navigation_start;
const _: unsafe extern "C" fn(
    *mut NavisCoreRuntime,
    u64,
    u64,
    *const u8,
    usize,
    *mut bool,
) -> NavisCoreStatus = navis_core_runtime_set_navigation_location;
const _: unsafe extern "C" fn(
    *mut NavisCoreRuntime,
    u64,
    u64,
    *const u8,
    usize,
    *mut bool,
) -> NavisCoreStatus = navis_core_runtime_set_navigation_title;
const _: unsafe extern "C" fn(*mut NavisCoreRuntime, u64, u64, u32, *mut bool) -> NavisCoreStatus =
    navis_core_runtime_set_navigation_security;
const _: unsafe extern "C" fn(
    *mut NavisCoreRuntime,
    u64,
    u64,
    u32,
    *const u8,
    usize,
    *mut bool,
) -> NavisCoreStatus = navis_core_runtime_set_navigation_identity;
const _: unsafe extern "C" fn(
    *mut NavisCoreRuntime,
    u64,
    u64,
    bool,
    bool,
    *mut bool,
) -> NavisCoreStatus = navis_core_runtime_set_navigation_history;
const _: unsafe extern "C" fn(
    *mut NavisCoreRuntime,
    u64,
    u64,
    bool,
    u32,
    *mut bool,
) -> NavisCoreStatus = navis_core_runtime_finish_navigation;
const _: unsafe extern "C" fn(*mut NavisCoreRuntime, u64, u64, *mut bool) -> NavisCoreStatus =
    navis_core_runtime_stop_navigation;
const _: unsafe extern "C" fn(
    *mut NavisCoreRuntime,
    u64,
    *mut NavisCoreNavigationSnapshot,
) -> NavisCoreStatus = navis_core_runtime_navigation_snapshot;
const _: unsafe extern "C" fn(*const NavisCoreRuntime) -> NavisCoreStatus =
    navis_core_runtime_check_invariants;
const _: unsafe extern "C" fn(*mut NavisCoreRuntime, *mut bool) -> NavisCoreStatus =
    navis_core_runtime_shutdown;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c_abi_numeric_domains_match_the_header_contract() {
        assert_eq!(NavisCoreStatus::Ok as u32, 0);
        assert_eq!(NavisCoreStatus::NullPointer as u32, 1);
        assert_eq!(NavisCoreStatus::Closed as u32, 2);
        assert_eq!(NavisCoreStatus::UnknownWindow as u32, 3);
        assert_eq!(NavisCoreStatus::UnknownView as u32, 4);
        assert_eq!(NavisCoreStatus::UnknownSession as u32, 5);
        assert_eq!(NavisCoreStatus::Conflict as u32, 6);
        assert_eq!(NavisCoreStatus::InvariantViolation as u32, 7);
        assert_eq!(NavisCoreStatus::IdentifierExhausted as u32, 8);
        assert_eq!(NavisCoreStatus::InvalidArgument as u32, 9);

        for (value, expected) in [
            (0, NavigationCommand::Load),
            (1, NavigationCommand::Reload),
            (2, NavigationCommand::Back),
            (3, NavigationCommand::Forward),
            (4, NavigationCommand::Restore),
        ] {
            assert_eq!(navigation_command(value), Ok(expected));
        }
        assert_eq!(navigation_command(5), Err(NavisCoreStatus::InvalidArgument));

        assert_eq!(navigation_start_kind(0), Ok(NavigationStartKind::Standard));
        assert_eq!(
            navigation_start_kind(1),
            Ok(NavigationStartKind::InternalPage)
        );
        assert_eq!(
            navigation_start_kind(2),
            Err(NavisCoreStatus::InvalidArgument)
        );
        for (value, expected) in [
            (0, NavigationActivity::Idle),
            (1, NavigationActivity::Pending),
            (2, NavigationActivity::Visible),
            (3, NavigationActivity::Silent),
        ] {
            assert_eq!(navigation_activity_value(expected), value);
        }

        for (value, expected) in [
            (0, NavigationSecurity::Unknown),
            (1, NavigationSecurity::Insecure),
            (2, NavigationSecurity::Broken),
            (3, NavigationSecurity::Secure),
        ] {
            assert_eq!(navigation_security(value), Ok(expected));
            assert_eq!(navigation_security_value(expected), value);
        }
        assert_eq!(
            navigation_security(4),
            Err(NavisCoreStatus::InvalidArgument)
        );

        for (value, expected) in [
            (0, NavigationIdentity::Unknown),
            (1, NavigationIdentity::Web),
            (2, NavigationIdentity::InternalPage),
            (3, NavigationIdentity::BuiltInExtension),
            (4, NavigationIdentity::InternalError),
        ] {
            assert_eq!(navigation_identity(value), Ok(expected));
            assert_eq!(navigation_identity_value(expected), value);
        }
        assert_eq!(
            navigation_identity(5),
            Err(NavisCoreStatus::InvalidArgument)
        );
    }

    #[test]
    fn null_pointers_fail_closed() {
        let mut output = false;
        assert_eq!(
            unsafe { navis_core_runtime_is_closed(ptr::null(), &mut output) },
            NavisCoreStatus::NullPointer
        );
        let runtime = navis_core_runtime_new();
        assert_eq!(
            unsafe { navis_core_runtime_window_count(runtime, ptr::null_mut()) },
            NavisCoreStatus::NullPointer
        );
        unsafe { navis_core_runtime_free(runtime) };
    }

    #[test]
    fn c_abi_preserves_the_lifecycle_contract() {
        let runtime = navis_core_runtime_new();
        let mut window = 0;
        let mut view = 0;
        let mut session = 0;
        let mut changed = false;
        let mut can_attach = false;
        unsafe {
            assert_eq!(
                navis_core_runtime_register_window(runtime, &mut window),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_register_view(runtime, window, &mut view),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_create_session(runtime, view, &mut session),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_activate_session(runtime, session, &mut changed),
                NavisCoreStatus::Ok
            );
            assert!(changed);
            assert_eq!(
                navis_core_runtime_detach(runtime, session, view),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_can_attach(runtime, session, view, &mut can_attach),
                NavisCoreStatus::Ok
            );
            assert!(can_attach);
            assert_eq!(
                navis_core_runtime_attach(runtime, session, view),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_check_invariants(runtime),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_close_session(runtime, session),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_close_window(runtime, window),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_shutdown(runtime, &mut changed),
                NavisCoreStatus::Ok
            );
            assert!(changed);
            navis_core_runtime_free(runtime);
        }
    }

    #[test]
    fn c_abi_preserves_private_session_identity_and_errors() {
        let runtime = navis_core_runtime_new();
        let mut window = 0;
        let mut view = 0;
        let mut session = 0;
        let mut private = false;
        unsafe {
            assert_eq!(
                navis_core_runtime_register_window(runtime, &mut window),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_register_view(runtime, window, &mut view),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_create_session_with_mode(runtime, view, true, &mut session,),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_session_is_private(runtime, session, &mut private),
                NavisCoreStatus::Ok
            );
            assert!(private);
            assert_eq!(
                navis_core_runtime_session_is_private(runtime, session, ptr::null_mut()),
                NavisCoreStatus::NullPointer
            );
            assert_eq!(
                navis_core_runtime_close_session(runtime, session),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_session_is_private(runtime, session, &mut private),
                NavisCoreStatus::UnknownSession
            );
            navis_core_runtime_free(runtime);
        }
    }

    #[test]
    fn c_abi_preserves_navigation_identity_utf8_and_stale_rejection() {
        let runtime = navis_core_runtime_new();
        let mut window = 0;
        let mut view = 0;
        let mut session = 0;
        let first_url = "https://example.com/路径";
        let second_url = "https://example.org/new";
        let stale_url = "https://stale.invalid/";
        let title = "示例页面";
        let mut first = 0;
        let mut second = 0;
        let mut changed = true;

        unsafe {
            assert_eq!(
                navis_core_runtime_register_window(runtime, &mut window),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_register_view(runtime, window, &mut view),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_create_session(runtime, view, &mut session),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_begin_navigation(
                    runtime,
                    session,
                    0,
                    first_url.as_ptr(),
                    first_url.len(),
                    true,
                    &mut first,
                ),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_begin_navigation(
                    runtime,
                    session,
                    0,
                    second_url.as_ptr(),
                    second_url.len(),
                    true,
                    &mut second,
                ),
                NavisCoreStatus::Ok
            );
            assert_ne!(first, second);
            assert_eq!(
                navis_core_runtime_set_navigation_location(
                    runtime,
                    session,
                    first,
                    stale_url.as_ptr(),
                    stale_url.len(),
                    &mut changed,
                ),
                NavisCoreStatus::Ok
            );
            assert!(!changed);
            assert_eq!(
                navis_core_runtime_set_navigation_title(
                    runtime,
                    session,
                    second,
                    title.as_ptr(),
                    title.len(),
                    &mut changed,
                ),
                NavisCoreStatus::Ok
            );
            assert!(changed);
            assert_eq!(
                navis_core_runtime_set_navigation_security(
                    runtime,
                    session,
                    second,
                    3,
                    &mut changed,
                ),
                NavisCoreStatus::Ok
            );
            assert!(changed);
            let identity_key = "support";
            assert_eq!(
                navis_core_runtime_set_navigation_identity(
                    runtime,
                    session,
                    second,
                    2,
                    identity_key.as_ptr(),
                    identity_key.len(),
                    &mut changed,
                ),
                NavisCoreStatus::Ok
            );
            assert!(changed);
            assert_eq!(
                navis_core_runtime_finish_navigation(
                    runtime,
                    session,
                    second,
                    false,
                    0,
                    &mut changed,
                ),
                NavisCoreStatus::Ok
            );
            assert!(changed);

            let mut snapshot = std::mem::MaybeUninit::uninit();
            assert_eq!(
                navis_core_runtime_navigation_snapshot(runtime, session, snapshot.as_mut_ptr(),),
                NavisCoreStatus::Ok
            );
            let snapshot = snapshot.assume_init();
            assert_eq!(snapshot.navigation_id, second);
            assert_eq!(
                str::from_utf8(slice::from_raw_parts(snapshot.url, snapshot.url_length,)).unwrap(),
                second_url
            );
            assert_eq!(
                str::from_utf8(slice::from_raw_parts(snapshot.title, snapshot.title_length,))
                    .unwrap(),
                title
            );
            assert_eq!(snapshot.activity, 0);
            assert_eq!(snapshot.security, 3);
            assert_eq!(snapshot.identity, 2);
            assert_eq!(
                str::from_utf8(slice::from_raw_parts(
                    snapshot.identity_key,
                    snapshot.identity_key_length,
                ))
                .unwrap(),
                identity_key
            );
            assert!(!snapshot.has_failure);

            let content_url = "https://example.org/content-navigation";
            let mut content_navigation = 0;
            assert_eq!(
                navis_core_runtime_observe_navigation_start(
                    runtime,
                    session,
                    content_url.as_ptr(),
                    content_url.len(),
                    true,
                    0,
                    &mut content_navigation,
                ),
                NavisCoreStatus::Ok
            );
            assert_ne!(content_navigation, second);
            let mut content_snapshot = std::mem::MaybeUninit::uninit();
            assert_eq!(
                navis_core_runtime_navigation_snapshot(
                    runtime,
                    session,
                    content_snapshot.as_mut_ptr(),
                ),
                NavisCoreStatus::Ok
            );
            let content_snapshot = content_snapshot.assume_init();
            assert_eq!(content_snapshot.navigation_id, content_navigation);
            assert_eq!(content_snapshot.activity, 2);
            assert_eq!(
                str::from_utf8(slice::from_raw_parts(
                    content_snapshot.url,
                    content_snapshot.url_length,
                ))
                .unwrap(),
                content_url
            );
            let local_page_key = "local-page";
            assert_eq!(
                navis_core_runtime_set_navigation_identity(
                    runtime,
                    session,
                    content_navigation,
                    1,
                    local_page_key.as_ptr(),
                    local_page_key.len(),
                    &mut changed,
                ),
                NavisCoreStatus::Ok
            );
            assert!(changed);
            changed = false;
            let invalid_web_key = "localhost";
            assert_eq!(
                navis_core_runtime_set_navigation_identity(
                    runtime,
                    session,
                    content_navigation,
                    1,
                    invalid_web_key.as_ptr(),
                    invalid_web_key.len(),
                    &mut changed,
                ),
                NavisCoreStatus::InvalidArgument
            );
            assert!(!changed);
            let mut local_snapshot = std::mem::MaybeUninit::uninit();
            assert_eq!(
                navis_core_runtime_navigation_snapshot(
                    runtime,
                    session,
                    local_snapshot.as_mut_ptr(),
                ),
                NavisCoreStatus::Ok
            );
            let local_snapshot = local_snapshot.assume_init();
            assert_eq!(local_snapshot.identity, 1);
            assert_eq!(
                str::from_utf8(slice::from_raw_parts(
                    local_snapshot.identity_key,
                    local_snapshot.identity_key_length,
                ))
                .unwrap(),
                local_page_key
            );

            assert_eq!(
                navis_core_runtime_navigation_snapshot(runtime, session, ptr::null_mut()),
                NavisCoreStatus::NullPointer
            );
            navis_core_runtime_free(runtime);
        }
    }

    #[test]
    fn c_abi_rejects_invalid_navigation_values_without_mutation() {
        let runtime = navis_core_runtime_new();
        let mut window = 0;
        let mut view = 0;
        let mut session = 0;
        let mut navigation = 42;
        let invalid_utf8 = [0xff];
        unsafe {
            assert_eq!(
                navis_core_runtime_register_window(runtime, &mut window),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_register_view(runtime, window, &mut view),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_create_session(runtime, view, &mut session),
                NavisCoreStatus::Ok
            );
            assert_eq!(
                navis_core_runtime_begin_navigation(
                    runtime,
                    session,
                    99,
                    ptr::null(),
                    0,
                    false,
                    &mut navigation,
                ),
                NavisCoreStatus::InvalidArgument
            );
            assert_eq!(navigation, 42);
            assert_eq!(
                navis_core_runtime_begin_navigation(
                    runtime,
                    session,
                    0,
                    invalid_utf8.as_ptr(),
                    invalid_utf8.len(),
                    true,
                    &mut navigation,
                ),
                NavisCoreStatus::InvalidArgument
            );
            assert_eq!(navigation, 42);
            navis_core_runtime_free(runtime);
        }
    }
}
