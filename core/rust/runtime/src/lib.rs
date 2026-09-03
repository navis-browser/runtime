/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Platform-neutral Runtime, Session, and View lifecycle state for Navis Core.
//!
//! This crate deliberately has no Gecko, operating-system, UI, or async-runtime
//! dependency. Target backends project native objects onto these identifiers and
//! commit state changes only after the target operation succeeds.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;

macro_rules! id_type {
    ($name:ident) => {
        #[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
        pub struct $name(u64);

        impl $name {
            pub const fn from_raw(value: u64) -> Self {
                Self(value)
            }

            pub const fn get(self) -> u64 {
                self.0
            }
        }
    };
}

id_type!(WindowId);
id_type!(ViewId);
id_type!(SessionId);
id_type!(NavigationId);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NavigationCommand {
    Load,
    Reload,
    Back,
    Forward,
    Restore,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NavigationSecurity {
    Unknown,
    Insecure,
    Broken,
    Secure,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NavigationIdentity {
    Unknown,
    Web,
    InternalPage,
    BuiltInExtension,
    InternalError,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NavigationActivity {
    Idle,
    Pending,
    Visible,
    Silent,
}

impl NavigationActivity {
    pub fn is_loading(self) -> bool {
        self != Self::Idle
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NavigationStartKind {
    Standard,
    InternalPage,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NavigationSnapshot {
    pub revision: u64,
    pub navigation_id: NavigationId,
    pub url: String,
    pub title: String,
    pub activity: NavigationActivity,
    pub security: NavigationSecurity,
    pub identity: NavigationIdentity,
    pub identity_key: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub failure_code: Option<u32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CoreError {
    Closed,
    UnknownWindow,
    UnknownView,
    UnknownSession,
    WindowHasSessions,
    ViewAlreadyBound,
    SessionAlreadyAttached,
    SessionDetached,
    BindingMismatch,
    NavigationNotAllowed,
    InvalidArgument,
    IdentifierExhausted,
    InvariantViolation,
}

impl fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Closed => "runtime is closed",
            Self::UnknownWindow => "window does not belong to this runtime",
            Self::UnknownView => "view does not belong to this runtime",
            Self::UnknownSession => "session does not belong to this runtime",
            Self::WindowHasSessions => "window still owns live sessions",
            Self::ViewAlreadyBound => "view is already bound to a session",
            Self::SessionAlreadyAttached => "session is already attached to a view",
            Self::SessionDetached => "session is detached from every view",
            Self::BindingMismatch => "session and view binding does not match",
            Self::NavigationNotAllowed => "navigation command is not allowed in the current state",
            Self::InvalidArgument => "invalid Core argument",
            Self::IdentifierExhausted => "runtime identifier space is exhausted",
            Self::InvariantViolation => "runtime lifecycle invariant was violated",
        })
    }
}

impl Error for CoreError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionSnapshot {
    pub id: SessionId,
    pub window: WindowId,
    pub view: Option<ViewId>,
    pub private: bool,
    pub active: bool,
    pub crashed: bool,
    pub navigation: NavigationSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeSnapshot {
    pub closed: bool,
    pub windows: usize,
    pub views: usize,
    pub sessions: Vec<SessionSnapshot>,
}

#[derive(Debug)]
struct WindowState {
    sessions: BTreeSet<SessionId>,
    active_session: Option<SessionId>,
}

#[derive(Debug)]
struct ViewState {
    window: WindowId,
    session: Option<SessionId>,
}

#[derive(Debug)]
struct SessionState {
    window: WindowId,
    view: Option<ViewId>,
    private: bool,
    active: bool,
    crashed: bool,
    navigation: NavigationState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NavigationPhase {
    Idle,
    Pending,
    Loading,
    Stopped,
    Finished,
    Failed,
    Crashed,
}

#[derive(Debug)]
struct NavigationState {
    revision: u64,
    next_navigation_id: u64,
    navigation_id: NavigationId,
    url: String,
    title: String,
    activity: NavigationActivity,
    security: NavigationSecurity,
    identity: NavigationIdentity,
    identity_key: String,
    can_go_back: bool,
    can_go_forward: bool,
    failure_code: Option<u32>,
    phase: NavigationPhase,
}

fn validate_navigation_identity(
    identity: NavigationIdentity,
    identity_key: &str,
) -> Result<(), CoreError> {
    if identity_key.len() > 256
        || identity_key
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(CoreError::InvalidArgument);
    }
    match identity {
        NavigationIdentity::Unknown => {
            if !identity_key.is_empty() {
                return Err(CoreError::InvalidArgument);
            }
        }
        NavigationIdentity::Web => {
            if !identity_key.is_empty() && identity_key != "local-page" {
                return Err(CoreError::InvalidArgument);
            }
        }
        NavigationIdentity::InternalPage => {
            if identity_key.is_empty()
                || identity_key.split('/').any(|segment| {
                    segment.is_empty()
                        || !segment.bytes().all(|byte| {
                            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                        })
                })
            {
                return Err(CoreError::InvalidArgument);
            }
        }
        NavigationIdentity::InternalError => {
            if identity_key.is_empty()
                || !identity_key
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            {
                return Err(CoreError::InvalidArgument);
            }
        }
        NavigationIdentity::BuiltInExtension => {
            if identity_key.is_empty() {
                return Err(CoreError::InvalidArgument);
            }
        }
    }
    Ok(())
}

impl NavigationState {
    fn new() -> Self {
        Self {
            revision: 0,
            next_navigation_id: 1,
            navigation_id: NavigationId::from_raw(0),
            url: "about:blank".to_owned(),
            title: String::new(),
            activity: NavigationActivity::Idle,
            security: NavigationSecurity::Unknown,
            identity: NavigationIdentity::Unknown,
            identity_key: String::new(),
            can_go_back: false,
            can_go_forward: false,
            failure_code: None,
            phase: NavigationPhase::Idle,
        }
    }

    fn snapshot(&self) -> NavigationSnapshot {
        NavigationSnapshot {
            revision: self.revision,
            navigation_id: self.navigation_id,
            url: self.url.clone(),
            title: self.title.clone(),
            activity: self.activity,
            security: self.security,
            identity: self.identity,
            identity_key: self.identity_key.clone(),
            can_go_back: self.can_go_back,
            can_go_forward: self.can_go_forward,
            failure_code: self.failure_code,
        }
    }

    fn bump_revision(&mut self) -> Result<(), CoreError> {
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or(CoreError::IdentifierExhausted)?;
        Ok(())
    }
}

/// Authoritative lifecycle graph shared by every Navis platform backend.
#[derive(Debug)]
pub struct Runtime {
    closed: bool,
    next_id: u64,
    windows: BTreeMap<WindowId, WindowState>,
    views: BTreeMap<ViewId, ViewState>,
    sessions: BTreeMap<SessionId, SessionState>,
}

impl Default for Runtime {
    fn default() -> Self {
        Self::new()
    }
}

impl Runtime {
    pub fn new() -> Self {
        Self {
            closed: false,
            next_id: 1,
            windows: BTreeMap::new(),
            views: BTreeMap::new(),
            sessions: BTreeMap::new(),
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn window_count(&self) -> usize {
        self.windows.len()
    }

    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    pub fn register_window(&mut self) -> Result<WindowId, CoreError> {
        self.require_open()?;
        let id = WindowId(self.allocate_id()?);
        self.windows.insert(
            id,
            WindowState {
                sessions: BTreeSet::new(),
                active_session: None,
            },
        );
        self.verify()?;
        Ok(id)
    }

    pub fn close_window(&mut self, window: WindowId) -> Result<(), CoreError> {
        self.require_open()?;
        let state = self.windows.get(&window).ok_or(CoreError::UnknownWindow)?;
        if !state.sessions.is_empty() {
            return Err(CoreError::WindowHasSessions);
        }
        self.windows.remove(&window);
        self.views.retain(|_, state| state.window != window);
        self.verify()
    }

    pub fn register_view(&mut self, window: WindowId) -> Result<ViewId, CoreError> {
        self.require_open()?;
        if !self.windows.contains_key(&window) {
            return Err(CoreError::UnknownWindow);
        }
        let id = ViewId(self.allocate_id()?);
        self.views.insert(
            id,
            ViewState {
                window,
                session: None,
            },
        );
        self.verify()?;
        Ok(id)
    }

    pub fn create_session(&mut self, view: ViewId) -> Result<SessionId, CoreError> {
        self.create_session_with_mode(view, false)
    }

    pub fn create_session_with_mode(
        &mut self,
        view: ViewId,
        private: bool,
    ) -> Result<SessionId, CoreError> {
        self.require_open()?;
        let view_state = self.views.get(&view).ok_or(CoreError::UnknownView)?;
        if view_state.session.is_some() {
            return Err(CoreError::ViewAlreadyBound);
        }
        let window = view_state.window;
        let id = SessionId(self.allocate_id()?);

        self.views
            .get_mut(&view)
            .expect("validated view disappeared")
            .session = Some(id);
        self.windows
            .get_mut(&window)
            .expect("view references an unknown window")
            .sessions
            .insert(id);
        self.sessions.insert(
            id,
            SessionState {
                window,
                view: Some(view),
                private,
                active: false,
                crashed: false,
                navigation: NavigationState::new(),
            },
        );
        self.verify()?;
        Ok(id)
    }

    pub fn session_is_private(&self, session: SessionId) -> Result<bool, CoreError> {
        self.require_open()?;
        self.sessions
            .get(&session)
            .map(|state| state.private)
            .ok_or(CoreError::UnknownSession)
    }

    pub fn activate_session(&mut self, session: SessionId) -> Result<bool, CoreError> {
        self.require_open()?;
        let window = self
            .sessions
            .get(&session)
            .ok_or(CoreError::UnknownSession)?
            .window;
        let previous = self
            .windows
            .get(&window)
            .ok_or(CoreError::InvariantViolation)?
            .active_session;
        if previous == Some(session) {
            return Ok(false);
        }
        if let Some(previous) = previous {
            self.sessions
                .get_mut(&previous)
                .ok_or(CoreError::InvariantViolation)?
                .active = false;
        }
        self.windows
            .get_mut(&window)
            .ok_or(CoreError::InvariantViolation)?
            .active_session = Some(session);
        self.sessions
            .get_mut(&session)
            .ok_or(CoreError::InvariantViolation)?
            .active = true;
        self.verify()?;
        Ok(true)
    }

    pub fn close_session(&mut self, session: SessionId) -> Result<(), CoreError> {
        self.require_open()?;
        let state = self
            .sessions
            .remove(&session)
            .ok_or(CoreError::UnknownSession)?;
        if let Some(view) = state.view {
            let view_state = self
                .views
                .get_mut(&view)
                .ok_or(CoreError::InvariantViolation)?;
            if view_state.session != Some(session) {
                return Err(CoreError::InvariantViolation);
            }
            view_state.session = None;
        }
        let window = self
            .windows
            .get_mut(&state.window)
            .ok_or(CoreError::InvariantViolation)?;
        window.sessions.remove(&session);
        if window.active_session == Some(session) {
            window.active_session = None;
        }
        self.verify()
    }

    pub fn can_attach(&self, session: SessionId, view: ViewId) -> Result<bool, CoreError> {
        self.require_open()?;
        let session_state = self
            .sessions
            .get(&session)
            .ok_or(CoreError::UnknownSession)?;
        let view_state = self.views.get(&view).ok_or(CoreError::UnknownView)?;
        Ok(session_state.view.is_none() && view_state.session.is_none())
    }

    pub fn attach(&mut self, session: SessionId, view: ViewId) -> Result<(), CoreError> {
        self.require_open()?;
        let session_state = self
            .sessions
            .get(&session)
            .ok_or(CoreError::UnknownSession)?;
        if session_state.view.is_some() {
            return Err(CoreError::SessionAlreadyAttached);
        }
        let source_window = session_state.window;
        let was_active = session_state.active;
        let view_state = self.views.get(&view).ok_or(CoreError::UnknownView)?;
        if view_state.session.is_some() {
            return Err(CoreError::ViewAlreadyBound);
        }
        let destination_window = view_state.window;

        if source_window != destination_window {
            let source = self
                .windows
                .get_mut(&source_window)
                .ok_or(CoreError::InvariantViolation)?;
            source.sessions.remove(&session);
            if source.active_session == Some(session) {
                source.active_session = None;
            }

            let destination = self
                .windows
                .get_mut(&destination_window)
                .ok_or(CoreError::InvariantViolation)?;
            destination.sessions.insert(session);
            if was_active {
                if let Some(previous) = destination.active_session {
                    self.sessions
                        .get_mut(&previous)
                        .ok_or(CoreError::InvariantViolation)?
                        .active = false;
                }
                destination.active_session = Some(session);
            }
        }

        self.sessions
            .get_mut(&session)
            .ok_or(CoreError::InvariantViolation)?
            .window = destination_window;
        self.sessions
            .get_mut(&session)
            .ok_or(CoreError::InvariantViolation)?
            .view = Some(view);
        self.views
            .get_mut(&view)
            .ok_or(CoreError::InvariantViolation)?
            .session = Some(session);
        self.verify()
    }

    pub fn detach(&mut self, session: SessionId, view: ViewId) -> Result<(), CoreError> {
        self.require_open()?;
        let session_state = self
            .sessions
            .get(&session)
            .ok_or(CoreError::UnknownSession)?;
        if session_state.view.is_none() {
            return Err(CoreError::SessionDetached);
        }
        if session_state.view != Some(view) {
            return Err(CoreError::BindingMismatch);
        }
        let view_state = self.views.get(&view).ok_or(CoreError::UnknownView)?;
        if view_state.session != Some(session) {
            return Err(CoreError::InvariantViolation);
        }
        self.sessions
            .get_mut(&session)
            .ok_or(CoreError::InvariantViolation)?
            .view = None;
        self.views
            .get_mut(&view)
            .ok_or(CoreError::InvariantViolation)?
            .session = None;
        self.verify()
    }

    pub fn begin_navigation(
        &mut self,
        session: SessionId,
        command: NavigationCommand,
        requested_url: Option<&str>,
    ) -> Result<NavigationId, CoreError> {
        self.require_open()?;
        let state = self
            .sessions
            .get_mut(&session)
            .ok_or(CoreError::UnknownSession)?;

        let allowed = match command {
            NavigationCommand::Load => requested_url.is_some_and(|url| !url.is_empty()),
            NavigationCommand::Reload => !state.crashed,
            NavigationCommand::Back => !state.crashed && state.navigation.can_go_back,
            NavigationCommand::Forward => !state.crashed && state.navigation.can_go_forward,
            NavigationCommand::Restore => state.crashed,
        };
        if !allowed {
            return Err(CoreError::NavigationNotAllowed);
        }

        let navigation_id = NavigationId::from_raw(state.navigation.next_navigation_id);
        let next_navigation_id = state
            .navigation
            .next_navigation_id
            .checked_add(1)
            .ok_or(CoreError::IdentifierExhausted)?;
        let next_revision = state
            .navigation
            .revision
            .checked_add(1)
            .ok_or(CoreError::IdentifierExhausted)?;

        state.navigation.next_navigation_id = next_navigation_id;
        state.navigation.navigation_id = navigation_id;
        state.navigation.revision = next_revision;
        // A command has been accepted, but Gecko has not identified the
        // actual top-level request yet. Keep the activity pending until the
        // binding classifies that request by its real channel.
        state.navigation.activity = NavigationActivity::Pending;
        state.navigation.security = NavigationSecurity::Unknown;
        state.navigation.identity = NavigationIdentity::Unknown;
        state.navigation.identity_key.clear();
        state.navigation.failure_code = None;
        state.navigation.phase = NavigationPhase::Pending;
        if let Some(url) = requested_url {
            state.navigation.url = url.to_owned();
        }
        if matches!(
            command,
            NavigationCommand::Load | NavigationCommand::Restore
        ) {
            state.crashed = false;
        }
        self.verify()?;
        Ok(navigation_id)
    }

    pub fn observe_navigation_start(
        &mut self,
        session: SessionId,
        requested_url: Option<&str>,
        start_kind: NavigationStartKind,
    ) -> Result<NavigationId, CoreError> {
        self.require_open()?;
        let state = self
            .sessions
            .get_mut(&session)
            .ok_or(CoreError::UnknownSession)?;
        if state.crashed || state.navigation.phase == NavigationPhase::Crashed {
            return Err(CoreError::NavigationNotAllowed);
        }
        let activity = match start_kind {
            NavigationStartKind::Standard => NavigationActivity::Visible,
            NavigationStartKind::InternalPage => NavigationActivity::Silent,
        };
        if matches!(
            state.navigation.phase,
            NavigationPhase::Pending | NavigationPhase::Loading
        ) {
            let navigation_id = state.navigation.navigation_id;
            if state.navigation.activity != activity {
                state.navigation.bump_revision()?;
                state.navigation.activity = activity;
            }
            state.navigation.phase = NavigationPhase::Loading;
            self.verify()?;
            return Ok(navigation_id);
        }

        let navigation_id = NavigationId::from_raw(state.navigation.next_navigation_id);
        let next_navigation_id = state
            .navigation
            .next_navigation_id
            .checked_add(1)
            .ok_or(CoreError::IdentifierExhausted)?;
        let next_revision = state
            .navigation
            .revision
            .checked_add(1)
            .ok_or(CoreError::IdentifierExhausted)?;
        state.navigation.next_navigation_id = next_navigation_id;
        state.navigation.navigation_id = navigation_id;
        state.navigation.revision = next_revision;
        state.navigation.activity = activity;
        state.navigation.security = NavigationSecurity::Unknown;
        state.navigation.identity = NavigationIdentity::Unknown;
        state.navigation.identity_key.clear();
        state.navigation.failure_code = None;
        state.navigation.phase = NavigationPhase::Loading;
        if let Some(url) = requested_url.filter(|url| !url.is_empty()) {
            state.navigation.url = url.to_owned();
        }
        self.verify()?;
        Ok(navigation_id)
    }

    pub fn set_navigation_location(
        &mut self,
        session: SessionId,
        navigation: NavigationId,
        url: &str,
    ) -> Result<bool, CoreError> {
        if url.is_empty() {
            return Err(CoreError::NavigationNotAllowed);
        }
        let Some(state) = self.current_navigation_mut(session, navigation)? else {
            return Ok(false);
        };
        if state.phase == NavigationPhase::Crashed || state.url == url {
            return Ok(false);
        }
        state.bump_revision()?;
        state.url.clear();
        state.url.push_str(url);
        Ok(true)
    }

    pub fn set_navigation_title(
        &mut self,
        session: SessionId,
        navigation: NavigationId,
        title: &str,
    ) -> Result<bool, CoreError> {
        let Some(state) = self.current_navigation_mut(session, navigation)? else {
            return Ok(false);
        };
        if state.phase == NavigationPhase::Crashed || state.title == title {
            return Ok(false);
        }
        state.bump_revision()?;
        state.title.clear();
        state.title.push_str(title);
        Ok(true)
    }

    pub fn set_navigation_security(
        &mut self,
        session: SessionId,
        navigation: NavigationId,
        security: NavigationSecurity,
    ) -> Result<bool, CoreError> {
        let Some(state) = self.current_navigation_mut(session, navigation)? else {
            return Ok(false);
        };
        if state.phase == NavigationPhase::Crashed || state.security == security {
            return Ok(false);
        }
        state.bump_revision()?;
        state.security = security;
        Ok(true)
    }

    pub fn set_navigation_identity(
        &mut self,
        session: SessionId,
        navigation: NavigationId,
        identity: NavigationIdentity,
        identity_key: &str,
    ) -> Result<bool, CoreError> {
        validate_navigation_identity(identity, identity_key)?;
        let Some(state) = self.current_navigation_mut(session, navigation)? else {
            return Ok(false);
        };
        if state.phase == NavigationPhase::Crashed
            || (state.identity == identity && state.identity_key == identity_key)
        {
            return Ok(false);
        }
        state.bump_revision()?;
        state.identity = identity;
        state.identity_key.clear();
        state.identity_key.push_str(identity_key);
        Ok(true)
    }

    pub fn set_navigation_history(
        &mut self,
        session: SessionId,
        navigation: NavigationId,
        can_go_back: bool,
        can_go_forward: bool,
    ) -> Result<bool, CoreError> {
        let Some(state) = self.current_navigation_mut(session, navigation)? else {
            return Ok(false);
        };
        if state.phase == NavigationPhase::Crashed
            || (state.can_go_back == can_go_back && state.can_go_forward == can_go_forward)
        {
            return Ok(false);
        }
        state.bump_revision()?;
        state.can_go_back = can_go_back;
        state.can_go_forward = can_go_forward;
        Ok(true)
    }

    pub fn finish_navigation(
        &mut self,
        session: SessionId,
        navigation: NavigationId,
        failure_code: Option<u32>,
    ) -> Result<bool, CoreError> {
        let Some(state) = self.current_navigation_mut(session, navigation)? else {
            return Ok(false);
        };
        if matches!(
            state.phase,
            NavigationPhase::Stopped
                | NavigationPhase::Finished
                | NavigationPhase::Failed
                | NavigationPhase::Crashed
        ) {
            return Ok(false);
        }
        let next_phase = if failure_code.is_some() {
            NavigationPhase::Failed
        } else {
            NavigationPhase::Finished
        };
        if !state.activity.is_loading()
            && state.phase == next_phase
            && state.failure_code == failure_code
        {
            return Ok(false);
        }
        state.bump_revision()?;
        state.activity = NavigationActivity::Idle;
        state.failure_code = failure_code;
        state.phase = next_phase;
        Ok(true)
    }

    pub fn stop_navigation(
        &mut self,
        session: SessionId,
        navigation: NavigationId,
    ) -> Result<bool, CoreError> {
        let Some(state) = self.current_navigation_mut(session, navigation)? else {
            return Ok(false);
        };
        if !state.activity.is_loading()
            || !matches!(
                state.phase,
                NavigationPhase::Pending | NavigationPhase::Loading
            )
        {
            return Ok(false);
        }
        state.bump_revision()?;
        state.activity = NavigationActivity::Idle;
        state.failure_code = None;
        state.phase = NavigationPhase::Stopped;
        Ok(true)
    }

    pub fn navigation_snapshot(&self, session: SessionId) -> Result<NavigationSnapshot, CoreError> {
        self.require_open()?;
        Ok(self
            .sessions
            .get(&session)
            .ok_or(CoreError::UnknownSession)?
            .navigation
            .snapshot())
    }

    pub fn set_crashed(&mut self, session: SessionId, crashed: bool) -> Result<(), CoreError> {
        self.require_open()?;
        let state = self
            .sessions
            .get_mut(&session)
            .ok_or(CoreError::UnknownSession)?;
        let navigation_changes = crashed
            && (state.navigation.activity != NavigationActivity::Idle
                || state.navigation.security != NavigationSecurity::Unknown
                || state.navigation.identity != NavigationIdentity::Unknown
                || !state.navigation.identity_key.is_empty()
                || state.navigation.can_go_back
                || state.navigation.can_go_forward
                || state.navigation.failure_code.is_some()
                || state.navigation.phase != NavigationPhase::Crashed);
        if state.crashed == crashed && !navigation_changes {
            return Ok(());
        }
        state.navigation.bump_revision()?;
        state.crashed = crashed;
        if crashed {
            state.navigation.activity = NavigationActivity::Idle;
            state.navigation.security = NavigationSecurity::Unknown;
            state.navigation.identity = NavigationIdentity::Unknown;
            state.navigation.identity_key.clear();
            state.navigation.can_go_back = false;
            state.navigation.can_go_forward = false;
            state.navigation.failure_code = None;
            state.navigation.phase = NavigationPhase::Crashed;
        } else if state.navigation.phase == NavigationPhase::Crashed {
            state.navigation.phase = NavigationPhase::Idle;
        }
        self.verify()
    }

    pub fn snapshot(&self) -> RuntimeSnapshot {
        RuntimeSnapshot {
            closed: self.closed,
            windows: self.windows.len(),
            views: self.views.len(),
            sessions: self
                .sessions
                .iter()
                .map(|(&id, state)| SessionSnapshot {
                    id,
                    window: state.window,
                    view: state.view,
                    private: state.private,
                    active: state.active,
                    crashed: state.crashed,
                    navigation: state.navigation.snapshot(),
                })
                .collect(),
        }
    }

    pub fn check_invariants(&self) -> Result<(), CoreError> {
        self.verify()
    }

    pub fn shutdown(&mut self) -> Result<bool, CoreError> {
        if self.closed {
            return Ok(false);
        }
        self.sessions.clear();
        self.views.clear();
        self.windows.clear();
        self.closed = true;
        self.verify()?;
        Ok(true)
    }

    fn allocate_id(&mut self) -> Result<u64, CoreError> {
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or(CoreError::IdentifierExhausted)?;
        Ok(id)
    }

    fn require_open(&self) -> Result<(), CoreError> {
        if self.closed {
            Err(CoreError::Closed)
        } else {
            Ok(())
        }
    }

    fn current_navigation_mut(
        &mut self,
        session: SessionId,
        navigation: NavigationId,
    ) -> Result<Option<&mut NavigationState>, CoreError> {
        self.require_open()?;
        let state = self
            .sessions
            .get_mut(&session)
            .ok_or(CoreError::UnknownSession)?;
        if navigation.get() == 0 || state.navigation.navigation_id != navigation {
            return Ok(None);
        }
        Ok(Some(&mut state.navigation))
    }

    fn verify(&self) -> Result<(), CoreError> {
        if self.closed {
            return if self.windows.is_empty() && self.views.is_empty() && self.sessions.is_empty() {
                Ok(())
            } else {
                Err(CoreError::InvariantViolation)
            };
        }

        for (&window_id, window) in &self.windows {
            if let Some(active) = window.active_session {
                let session = self
                    .sessions
                    .get(&active)
                    .ok_or(CoreError::InvariantViolation)?;
                if session.window != window_id || !session.active {
                    return Err(CoreError::InvariantViolation);
                }
            }
            for session_id in &window.sessions {
                let session = self
                    .sessions
                    .get(session_id)
                    .ok_or(CoreError::InvariantViolation)?;
                if session.window != window_id {
                    return Err(CoreError::InvariantViolation);
                }
            }
        }

        for (&session_id, session) in &self.sessions {
            let window = self
                .windows
                .get(&session.window)
                .ok_or(CoreError::InvariantViolation)?;
            if !window.sessions.contains(&session_id)
                || session.active != (window.active_session == Some(session_id))
            {
                return Err(CoreError::InvariantViolation);
            }
            if let Some(view_id) = session.view {
                let view = self
                    .views
                    .get(&view_id)
                    .ok_or(CoreError::InvariantViolation)?;
                if view.session != Some(session_id) || view.window != session.window {
                    return Err(CoreError::InvariantViolation);
                }
            }
            let valid_activity = match session.navigation.phase {
                NavigationPhase::Pending => {
                    session.navigation.activity == NavigationActivity::Pending
                }
                NavigationPhase::Loading => matches!(
                    session.navigation.activity,
                    NavigationActivity::Visible | NavigationActivity::Silent
                ),
                NavigationPhase::Idle
                | NavigationPhase::Stopped
                | NavigationPhase::Finished
                | NavigationPhase::Failed
                | NavigationPhase::Crashed => {
                    session.navigation.activity == NavigationActivity::Idle
                }
            };
            if session.crashed != (session.navigation.phase == NavigationPhase::Crashed)
                || !valid_activity
                || session.navigation.failure_code.is_some()
                    != (session.navigation.phase == NavigationPhase::Failed)
            {
                return Err(CoreError::InvariantViolation);
            }
        }

        for (&view_id, view) in &self.views {
            if !self.windows.contains_key(&view.window) {
                return Err(CoreError::InvariantViolation);
            }
            if let Some(session_id) = view.session {
                let session = self
                    .sessions
                    .get(&session_id)
                    .ok_or(CoreError::InvariantViolation)?;
                if session.view != Some(view_id) {
                    return Err(CoreError::InvariantViolation);
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owns_lifecycle_and_reuses_a_released_view() {
        let mut runtime = Runtime::new();
        let window = runtime.register_window().unwrap();
        let view = runtime.register_view(window).unwrap();
        let first = runtime.create_session(view).unwrap();

        assert_eq!(runtime.session_count(), 1);
        assert!(runtime.activate_session(first).unwrap());
        assert!(!runtime.activate_session(first).unwrap());
        runtime.set_crashed(first, true).unwrap();
        assert!(runtime.snapshot().sessions[0].crashed);

        runtime.close_session(first).unwrap();
        let second = runtime.create_session(view).unwrap();
        assert_ne!(first, second);
        runtime.close_session(second).unwrap();
        runtime.close_window(window).unwrap();
        assert!(runtime.shutdown().unwrap());
        assert!(!runtime.shutdown().unwrap());
        assert!(runtime.is_closed());
    }

    #[test]
    fn private_mode_is_immutable_session_identity() {
        let mut runtime = Runtime::new();
        let window = runtime.register_window().unwrap();
        let normal_view = runtime.register_view(window).unwrap();
        let private_view = runtime.register_view(window).unwrap();
        let normal = runtime.create_session(normal_view).unwrap();
        let private = runtime
            .create_session_with_mode(private_view, true)
            .unwrap();

        assert!(!runtime.session_is_private(normal).unwrap());
        assert!(runtime.session_is_private(private).unwrap());
        let snapshot = runtime.snapshot();
        assert!(
            !snapshot
                .sessions
                .iter()
                .find(|state| state.id == normal)
                .unwrap()
                .private
        );
        assert!(
            snapshot
                .sessions
                .iter()
                .find(|state| state.id == private)
                .unwrap()
                .private
        );

        runtime.close_session(private).unwrap();
        assert_eq!(
            runtime.session_is_private(private),
            Err(CoreError::UnknownSession)
        );
    }

    #[test]
    fn private_mode_survives_view_transfer() {
        let mut runtime = Runtime::new();
        let first_window = runtime.register_window().unwrap();
        let second_window = runtime.register_window().unwrap();
        let first_view = runtime.register_view(first_window).unwrap();
        let second_view = runtime.register_view(second_window).unwrap();
        let session = runtime.create_session_with_mode(first_view, true).unwrap();

        runtime.detach(session, first_view).unwrap();
        runtime.attach(session, second_view).unwrap();

        assert!(runtime.session_is_private(session).unwrap());
        assert!(runtime.snapshot().sessions[0].private);
        runtime.check_invariants().unwrap();
    }

    #[test]
    fn live_session_moves_between_windows_without_recreation() {
        let mut runtime = Runtime::new();
        let first_window = runtime.register_window().unwrap();
        let second_window = runtime.register_window().unwrap();
        let first_view = runtime.register_view(first_window).unwrap();
        let second_view = runtime.register_view(second_window).unwrap();
        let occupied_view = runtime.register_view(second_window).unwrap();
        let moving = runtime.create_session(first_view).unwrap();
        let displaced = runtime.create_session(occupied_view).unwrap();
        runtime.activate_session(moving).unwrap();
        runtime.activate_session(displaced).unwrap();

        runtime.detach(moving, first_view).unwrap();
        assert!(runtime.can_attach(moving, second_view).unwrap());
        runtime.attach(moving, second_view).unwrap();

        let snapshot = runtime.snapshot();
        let moving_state = snapshot
            .sessions
            .iter()
            .find(|state| state.id == moving)
            .unwrap();
        let displaced_state = snapshot
            .sessions
            .iter()
            .find(|state| state.id == displaced)
            .unwrap();
        assert_eq!(moving_state.window, second_window);
        assert_eq!(moving_state.view, Some(second_view));
        assert!(moving_state.active);
        assert!(!displaced_state.active);
        runtime.check_invariants().unwrap();
    }

    #[test]
    fn failed_attach_is_transactional() {
        let mut runtime = Runtime::new();
        let window = runtime.register_window().unwrap();
        let first_view = runtime.register_view(window).unwrap();
        let second_view = runtime.register_view(window).unwrap();
        let first = runtime.create_session(first_view).unwrap();
        let second = runtime.create_session(second_view).unwrap();
        runtime.detach(first, first_view).unwrap();
        let before = runtime.snapshot();

        assert!(!runtime.can_attach(first, second_view).unwrap());
        assert_eq!(
            runtime.attach(first, second_view),
            Err(CoreError::ViewAlreadyBound)
        );
        assert_eq!(runtime.snapshot(), before);
        assert_eq!(
            runtime.detach(second, first_view),
            Err(CoreError::BindingMismatch)
        );
        assert_eq!(runtime.snapshot(), before);
    }

    #[test]
    fn window_cannot_disappear_while_it_owns_a_session() {
        let mut runtime = Runtime::new();
        let window = runtime.register_window().unwrap();
        let view = runtime.register_view(window).unwrap();
        let session = runtime.create_session(view).unwrap();

        assert_eq!(
            runtime.close_window(window),
            Err(CoreError::WindowHasSessions)
        );
        runtime.close_session(session).unwrap();
        runtime.close_window(window).unwrap();
        assert_eq!(runtime.window_count(), 0);
    }

    fn one_session() -> (Runtime, SessionId) {
        let mut runtime = Runtime::new();
        let window = runtime.register_window().unwrap();
        let view = runtime.register_view(window).unwrap();
        let session = runtime.create_session(view).unwrap();
        (runtime, session)
    }

    #[test]
    fn core_owns_normalized_navigation_state() {
        let (mut runtime, session) = one_session();
        let initial = runtime.navigation_snapshot(session).unwrap();
        assert_eq!(initial.navigation_id.get(), 0);
        assert_eq!(initial.url, "about:blank");
        assert_eq!(initial.activity, NavigationActivity::Idle);
        assert_eq!(initial.identity, NavigationIdentity::Unknown);
        assert!(initial.identity_key.is_empty());

        let navigation = runtime
            .begin_navigation(
                session,
                NavigationCommand::Load,
                Some("https://example.com/"),
            )
            .unwrap();
        let pending = runtime.navigation_snapshot(session).unwrap();
        assert_eq!(pending.activity, NavigationActivity::Pending);
        assert_eq!(
            runtime
                .observe_navigation_start(session, None, NavigationStartKind::Standard)
                .unwrap(),
            navigation
        );
        assert_eq!(
            runtime.navigation_snapshot(session).unwrap().activity,
            NavigationActivity::Visible
        );
        assert!(runtime
            .set_navigation_location(session, navigation, "https://www.example.com/redirected",)
            .unwrap());
        assert!(runtime
            .set_navigation_title(session, navigation, "Example")
            .unwrap());
        assert!(runtime
            .set_navigation_security(session, navigation, NavigationSecurity::Secure)
            .unwrap());
        assert!(runtime
            .set_navigation_identity(session, navigation, NavigationIdentity::Web, "")
            .unwrap());
        assert!(runtime
            .set_navigation_history(session, navigation, true, false)
            .unwrap());
        assert!(runtime
            .finish_navigation(session, navigation, None)
            .unwrap());

        let state = runtime.navigation_snapshot(session).unwrap();
        assert_eq!(state.navigation_id, navigation);
        assert_eq!(state.url, "https://www.example.com/redirected");
        assert_eq!(state.title, "Example");
        assert_eq!(state.security, NavigationSecurity::Secure);
        assert_eq!(state.identity, NavigationIdentity::Web);
        assert!(state.identity_key.is_empty());
        assert!(state.can_go_back);
        assert!(!state.can_go_forward);
        assert_eq!(state.activity, NavigationActivity::Idle);
        assert_eq!(state.failure_code, None);

        let finished = state.clone();
        assert!(!runtime
            .finish_navigation(session, navigation, Some(0x804b0002))
            .unwrap());
        assert_eq!(runtime.navigation_snapshot(session).unwrap(), finished);
        runtime.check_invariants().unwrap();
    }

    #[test]
    fn stale_navigation_events_cannot_overwrite_a_new_command() {
        let (mut runtime, session) = one_session();
        let first = runtime
            .begin_navigation(
                session,
                NavigationCommand::Load,
                Some("https://old.example/"),
            )
            .unwrap();
        let second = runtime
            .begin_navigation(
                session,
                NavigationCommand::Load,
                Some("https://new.example/"),
            )
            .unwrap();
        let before = runtime.navigation_snapshot(session).unwrap();

        assert!(!runtime
            .set_navigation_location(session, first, "https://stale.example/")
            .unwrap());
        assert!(!runtime
            .set_navigation_security(session, first, NavigationSecurity::Broken)
            .unwrap());
        assert!(!runtime
            .set_navigation_identity(session, first, NavigationIdentity::InternalPage, "support",)
            .unwrap());
        assert!(!runtime.finish_navigation(session, first, Some(1)).unwrap());
        assert_eq!(runtime.navigation_snapshot(session).unwrap(), before);

        assert!(runtime.finish_navigation(session, second, None).unwrap());
        assert_eq!(
            runtime.navigation_snapshot(session).unwrap().url,
            "https://new.example/"
        );
    }

    #[test]
    fn stopped_navigation_rejects_late_network_events() {
        let (mut runtime, session) = one_session();
        let navigation = runtime
            .begin_navigation(
                session,
                NavigationCommand::Load,
                Some("https://slow.example/"),
            )
            .unwrap();
        assert!(runtime.stop_navigation(session, navigation).unwrap());
        let stopped = runtime.navigation_snapshot(session).unwrap();
        assert_eq!(stopped.activity, NavigationActivity::Idle);

        assert!(!runtime
            .finish_navigation(session, navigation, Some(0x804b0002))
            .unwrap());
        assert_eq!(runtime.navigation_snapshot(session).unwrap(), stopped);
    }

    #[test]
    fn authenticated_navigation_identity_is_bounded_and_transactional() {
        let (mut runtime, session) = one_session();
        let navigation = runtime
            .begin_navigation(
                session,
                NavigationCommand::Load,
                Some("navis://settings/help"),
            )
            .unwrap();

        assert!(runtime
            .set_navigation_identity(
                session,
                navigation,
                NavigationIdentity::InternalPage,
                "settings/help",
            )
            .unwrap());
        let authenticated = runtime.navigation_snapshot(session).unwrap();
        assert_eq!(authenticated.identity, NavigationIdentity::InternalPage);
        assert_eq!(authenticated.identity_key, "settings/help");
        assert!(!runtime
            .set_navigation_identity(
                session,
                navigation,
                NavigationIdentity::InternalPage,
                "settings/help",
            )
            .unwrap());
        assert_eq!(
            runtime.set_navigation_identity(
                session,
                navigation,
                NavigationIdentity::InternalPage,
                "settings//escape",
            ),
            Err(CoreError::InvalidArgument)
        );
        assert_eq!(
            runtime.set_navigation_identity(
                session,
                navigation,
                NavigationIdentity::Web,
                "https://example.com",
            ),
            Err(CoreError::InvalidArgument)
        );
        assert_eq!(runtime.navigation_snapshot(session).unwrap(), authenticated);

        let local_navigation = runtime
            .begin_navigation(session, NavigationCommand::Load, Some("http://127.0.0.1/"))
            .unwrap();
        assert!(runtime
            .set_navigation_identity(
                session,
                local_navigation,
                NavigationIdentity::Web,
                "local-page",
            )
            .unwrap());
        let local = runtime.navigation_snapshot(session).unwrap();
        assert_eq!(local.identity, NavigationIdentity::Web);
        assert_eq!(local.identity_key, "local-page");
        assert_eq!(
            runtime.set_navigation_identity(
                session,
                local_navigation,
                NavigationIdentity::Web,
                "localhost",
            ),
            Err(CoreError::InvalidArgument)
        );
        assert_eq!(runtime.navigation_snapshot(session).unwrap(), local);

        let next = runtime
            .begin_navigation(
                session,
                NavigationCommand::Load,
                Some("moz-extension://generated/dashboard.html"),
            )
            .unwrap();
        let reset = runtime.navigation_snapshot(session).unwrap();
        assert_eq!(reset.identity, NavigationIdentity::Unknown);
        assert!(reset.identity_key.is_empty());
        assert!(runtime
            .set_navigation_identity(
                session,
                next,
                NavigationIdentity::BuiltInExtension,
                "builtin@example.test",
            )
            .unwrap());
    }

    #[test]
    fn content_navigation_gets_a_core_identity_after_a_finished_command() {
        let (mut runtime, session) = one_session();
        let product_navigation = runtime
            .begin_navigation(
                session,
                NavigationCommand::Load,
                Some("https://example.com/"),
            )
            .unwrap();
        runtime
            .finish_navigation(session, product_navigation, None)
            .unwrap();

        let content_navigation = runtime
            .observe_navigation_start(
                session,
                Some("https://example.com/slow"),
                NavigationStartKind::Standard,
            )
            .unwrap();
        assert_ne!(content_navigation, product_navigation);
        let state = runtime.navigation_snapshot(session).unwrap();
        assert_eq!(state.navigation_id, content_navigation);
        assert_eq!(state.url, "https://example.com/slow");
        assert_eq!(state.activity, NavigationActivity::Visible);

        assert_eq!(
            runtime
                .observe_navigation_start(
                    session,
                    Some("https://redirect.example/"),
                    NavigationStartKind::Standard,
                )
                .unwrap(),
            content_navigation
        );
        assert_eq!(
            runtime.navigation_snapshot(session).unwrap().url,
            "https://example.com/slow"
        );
    }

    #[test]
    fn rejected_navigation_command_is_transactional() {
        let (mut runtime, session) = one_session();
        let before = runtime.navigation_snapshot(session).unwrap();
        assert_eq!(
            runtime.begin_navigation(session, NavigationCommand::Back, None),
            Err(CoreError::NavigationNotAllowed)
        );
        assert_eq!(runtime.navigation_snapshot(session).unwrap(), before);

        let load = runtime
            .begin_navigation(
                session,
                NavigationCommand::Load,
                Some("https://example.com/"),
            )
            .unwrap();
        runtime
            .set_navigation_history(session, load, true, false)
            .unwrap();
        runtime.finish_navigation(session, load, None).unwrap();
        assert!(runtime
            .begin_navigation(session, NavigationCommand::Back, None)
            .is_ok());
    }

    #[test]
    fn crash_terminates_navigation_and_restore_gets_a_new_identity() {
        let (mut runtime, session) = one_session();
        let first = runtime
            .begin_navigation(
                session,
                NavigationCommand::Load,
                Some("https://example.com/"),
            )
            .unwrap();
        runtime
            .set_navigation_security(session, first, NavigationSecurity::Secure)
            .unwrap();
        runtime
            .set_navigation_identity(session, first, NavigationIdentity::Web, "")
            .unwrap();
        runtime.set_crashed(session, true).unwrap();

        let crashed = runtime.navigation_snapshot(session).unwrap();
        assert_eq!(crashed.activity, NavigationActivity::Idle);
        assert_eq!(crashed.security, NavigationSecurity::Unknown);
        assert_eq!(crashed.identity, NavigationIdentity::Unknown);
        assert!(crashed.identity_key.is_empty());
        assert_eq!(
            runtime.begin_navigation(session, NavigationCommand::Reload, None),
            Err(CoreError::NavigationNotAllowed)
        );

        let restored = runtime
            .begin_navigation(session, NavigationCommand::Restore, None)
            .unwrap();
        assert_ne!(restored, first);
        assert!(!runtime.snapshot().sessions[0].crashed);
        assert_eq!(
            runtime.navigation_snapshot(session).unwrap().activity,
            NavigationActivity::Pending
        );
    }

    #[test]
    fn loading_presentation_is_separate_from_document_lifecycle() {
        let (mut runtime, session) = one_session();
        let navigation = runtime
            .begin_navigation(session, NavigationCommand::Load, Some("navis://newtab/"))
            .unwrap();

        let pending = runtime.navigation_snapshot(session).unwrap();
        assert_eq!(pending.activity, NavigationActivity::Pending);

        assert_eq!(
            runtime
                .observe_navigation_start(
                    session,
                    Some("navis://newtab/"),
                    NavigationStartKind::InternalPage,
                )
                .unwrap(),
            navigation
        );
        let internal = runtime.navigation_snapshot(session).unwrap();
        assert_eq!(internal.activity, NavigationActivity::Silent);

        let revision = internal.revision;
        assert_eq!(
            runtime
                .observe_navigation_start(
                    session,
                    Some("https://example.com/"),
                    NavigationStartKind::Standard,
                )
                .unwrap(),
            navigation
        );
        let redirected = runtime.navigation_snapshot(session).unwrap();
        assert_eq!(redirected.activity, NavigationActivity::Visible);
        assert!(redirected.revision > revision);

        assert!(runtime
            .finish_navigation(session, navigation, None)
            .unwrap());
        let finished = runtime.navigation_snapshot(session).unwrap();
        assert_eq!(finished.activity, NavigationActivity::Idle);
        runtime.check_invariants().unwrap();
    }
}
