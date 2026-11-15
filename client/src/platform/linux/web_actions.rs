use super::smart_url;
use crate::bundle::WebActions;
use gtk4::glib;
use gtk4::prelude::*;
use std::{cell::{Cell,RefCell},rc::Rc,time::Duration};
use webkit6::prelude::*;

pub(super) struct Actions(Rc<State>);
struct State {
    view: glib::WeakRef<webkit6::WebView>,
    config: WebActions,
    server: String,
    key: String,
    auth: Option<smart_url::Readiness>,
    pending_load: Cell<bool>,
    current: RefCell<Option<smart_url::Controller>>,
}
impl Actions {
    pub(super) fn new(view: &webkit6::WebView, config: WebActions, auth: Option<smart_url::Readiness>, server: &str, key: &str) -> Self {
        let state = Rc::new(State { view: view.downgrade(), config, server: server.into(), key: key.into(), auth,
            pending_load: Cell::new(false), current: RefCell::new(None) });
        let weak = Rc::downgrade(&state);
        view.connect_map(move |_| { if let Some(state) = weak.upgrade() { state.pending_load.set(true); } });
        let weak = Rc::downgrade(&state);
        glib::timeout_add_local(Duration::from_millis(100), move || {
            let Some(state) = weak.upgrade() else { return glib::ControlFlow::Break };
            let Some(view) = state.view.upgrade() else { return glib::ControlFlow::Break };
            if state.pending_load.get() && view.is_mapped() && !view.is_loading() && !state.busy()
                && state.auth.as_ref().is_none_or(|auth| auth.ready(&view)) {
                state.pending_load.set(false);
                if !state.config.on_load.is_empty() {
                    state.start(state.config.on_load.clone(), |result| {
                        if let Err(error) = result { tracing::warn!("web on-load actions: {error}"); }
                    });
                }
            }
            glib::ControlFlow::Continue
        });
        Self(state)
    }
    pub(super) fn invoke(&self, group: &str, revision: &str, done: impl FnOnce(Result<(),String>) + 'static) -> Result<(),String> {
        let state = &self.0;
        let view = state.view.upgrade().ok_or("View disposed")?;
        if revision != state.config.revision { return Err("Block configuration changed; waiting for bundle refresh".into()); }
        if !view.is_mapped() || view.is_loading() || state.auth.as_ref().is_some_and(|auth| !auth.ready(&view)) {
            return Err("Block is not ready".into());
        }
        if state.pending_load.get() || state.busy() { return Err("Another sequence is running in this block".into()); }
        let steps = state.config.groups.get(group).ok_or("Group not found")?.clone();
        state.start(steps, done);
        Ok(())
    }
}
impl State {
    fn busy(&self) -> bool { self.current.borrow().as_ref().is_some_and(|job| !job.is_finished()) }
    fn start(&self, steps: Vec<crate::bundle::SmartUrlStep>, done: impl FnOnce(Result<(),String>) + 'static) {
        self.current.borrow_mut().take();
        let Some(view) = self.view.upgrade() else { done(Err("View disposed".into())); return };
        let controller = smart_url::run_sequence(&view, steps, &self.server, &self.key, self.auth.clone(), done);
        self.current.replace(Some(controller));
    }
}
