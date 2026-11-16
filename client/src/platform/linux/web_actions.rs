use super::smart_url;
use crate::bundle::WebActions;
use gtk4::glib;
use gtk4::prelude::*;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};
use webkit6::prelude::*;

pub(super) struct Actions(Rc<State>, Option<glib::SignalHandlerId>);

struct State {
    view: glib::WeakRef<webkit6::WebView>,
    config: RefCell<WebActions>,
    server: RefCell<String>,
    key: RefCell<String>,
    auth: Option<smart_url::Readiness>,
    pending_load: Cell<bool>,
    current: RefCell<Option<smart_url::Controller>>,
}

impl Actions {
    pub(super) fn new(
        view: &webkit6::WebView,
        config: WebActions,
        auth: Option<smart_url::Readiness>,
        server: &str,
        key: &str,
    ) -> Self {
        let state = Rc::new(State {
            view: view.downgrade(),
            config: RefCell::new(config),
            server: RefCell::new(server.into()),
            key: RefCell::new(key.into()),
            auth,
            pending_load: Cell::new(false),
            current: RefCell::new(None),
        });
        let weak = Rc::downgrade(&state);
        let mapped = view.connect_map(move |_| {
            if let Some(state) = weak.upgrade() {
                state.pending_load.set(true);
            }
        });
        let weak = Rc::downgrade(&state);
        // Mapping can precede navigation/login completion. Defer until the
        // existing entity-auth runner and page are ready, without overlapping.
        glib::timeout_add_local(Duration::from_millis(100), move || {
            let Some(state) = weak.upgrade() else {
                return glib::ControlFlow::Break;
            };
            let Some(view) = state.view.upgrade() else {
                return glib::ControlFlow::Break;
            };
            if state.pending_load.get()
                && view.is_mapped()
                && !view.is_loading()
                && !super::web_policy::page_failed(&view)
                && !state.busy()
                && state.auth.as_ref().is_none_or(|auth| auth.ready(&view))
            {
                state.pending_load.set(false);
                let steps = state.config.borrow().on_load.clone();
                if !steps.is_empty() {
                    state.start(steps, false, |result| {
                        if let Err(error) = result {
                            tracing::warn!("web on-load actions: {error}");
                        }
                    });
                }
            }
            glib::ControlFlow::Continue
        });
        Self(state, Some(mapped))
    }

    /// Replace future definitions without dropping pending on-load work or an
    /// accepted sequence, whose runner already owns its steps and credentials.
    pub(super) fn update(&self, config: WebActions, server: &str, key: &str) {
        self.0.config.replace(config);
        self.0.server.replace(server.into());
        self.0.key.replace(key.into());
    }

    pub(super) fn invoke(
        &self,
        group: &str,
        revision: &str,
        done: impl FnOnce(Result<(), String>) + 'static,
    ) -> Result<(), String> {
        let state = &self.0;
        let view = state.view.upgrade().ok_or("View disposed")?;
        if revision != state.config.borrow().revision {
            return Err("Block configuration changed; waiting for bundle refresh".into());
        }
        if !view.is_mapped()
            || view.is_loading()
            || super::web_policy::page_failed(&view)
            || state.auth.as_ref().is_some_and(|auth| !auth.ready(&view))
        {
            return Err("Block is not ready".into());
        }
        if state.pending_load.get() || state.busy() {
            return Err("Another sequence is pending or running in this block".into());
        }
        let steps = state.config.borrow().groups.get(group).ok_or("Group not found")?.clone();
        state.start(steps, true, done);
        Ok(())
    }
}

impl State {
    fn busy(&self) -> bool {
        self.current.borrow().as_ref().is_some_and(|job| !job.is_finished())
    }

    fn start(
        &self,
        steps: Vec<crate::bundle::SmartUrlStep>,
        named_group: bool,
        done: impl FnOnce(Result<(), String>) + 'static,
    ) {
        self.current.borrow_mut().take();
        let Some(view) = self.view.upgrade() else {
            done(Err("View disposed".into()));
            return;
        };
        let auth_ready = if named_group { None } else { self.auth.clone() };
        let pause = if named_group { self.auth.as_ref().and_then(|auth| auth.pause_for_actions(&view)) } else { None };
        let controller = smart_url::run_sequence(
            &view, steps, &self.server.borrow(), &self.key.borrow(), auth_ready, move |result| {
                drop(pause);
                done(result);
            },
        );
        self.current.replace(Some(controller));
    }
}

impl Drop for Actions {
    fn drop(&mut self) {
        if let Some(view) = self.0.view.upgrade() {
            if let Some(handler) = self.1.take() {
                view.disconnect(handler);
            }
        }
    }
}
