//! Framework-neutral evaluation-scheduling decision logic, factored out so
//! it can be exercised by a fake port without launching Floem (see R12 in
//! `docs/m2-implementation-review-2026-09-10.md`).
//!
//! Scope: this module owns the *decisions* — debounce, cancel-on-supersede,
//! retry-after-recovery, and cache-acceptance gating. It does not own any
//! thread, timer, or subprocess; those stay adapter-side (in
//! `native/adapters/floem/src/main.rs`'s `schedule_evaluation`/`start_worker`,
//! which currently implement this same logic inline). This module is a
//! seam for that code to eventually call into, not a replacement shipped in
//! this pass — see the review's explicit "do not over-build" guidance for
//! R12.

use std::path::PathBuf;

use crate::EvaluationRequest;

/// Immutable identity of one evaluation request's inputs, captured in one
/// read rather than re-read piecemeal on every request (as
/// `PortableProject::session_evaluation_request` currently does). Two
/// records for the same `input_path` compare unequal if the file's content
/// (or the environment lock) changed between captures, which is the seam a
/// future input-selection UI (M3) needs without implementing that UI now.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct InputIdentity {
    pub template_id: String,
    pub template_version: String,
    pub input_path: PathBuf,
    pub input_digest: String,
    pub environment_digest: String,
}

/// What an adapter should do next in response to a decision point. The
/// runtime only decides; actually sending the request, sleeping out the
/// debounce, and owning the worker connection remain the adapter's job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeCommand {
    /// Send this request now.
    Send(EvaluationRequest),
    /// Cancel this generation — it was sent but has since been superseded.
    Cancel { session_id: String, generation: u64 },
    /// Nothing to do.
    None,
}

/// The decision logic behind evaluation scheduling: debounce,
/// cancel-on-supersede, and retry-after-recovery. An adapter feeds it
/// content-changed/debounce-elapsed/retry events and acts on the
/// `RuntimeCommand` each returns.
#[derive(Debug, Default)]
pub struct EvaluationRuntime {
    latest_generation: u64,
    sent_generation: Option<u64>,
    recovery_required: bool,
    last_request: Option<EvaluationRequest>,
}

impl EvaluationRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    /// The session's content genuinely changed (not a tab rebind) and
    /// `request` is the freshly-built evaluation for it. Records it as the
    /// latest, superseding whatever was previously sent — returns a
    /// `Cancel` for that generation if one was still in flight.
    pub fn content_changed(&mut self, request: EvaluationRequest) -> RuntimeCommand {
        self.latest_generation = request.generation;
        let session_id = request.session_id.clone();
        self.last_request = Some(request);
        match self.sent_generation.take() {
            Some(generation) => RuntimeCommand::Cancel {
                session_id,
                generation,
            },
            None => RuntimeCommand::None,
        }
    }

    /// The adapter's debounce timer for `generation` elapsed. Sends only if
    /// `generation` is still the latest requested and the worker isn't in
    /// recovery — an intervening edit or a crashed worker makes this stale.
    pub fn debounce_elapsed(&mut self, generation: u64) -> RuntimeCommand {
        if self.recovery_required || generation != self.latest_generation {
            return RuntimeCommand::None;
        }
        let Some(request) = self.last_request.clone() else {
            return RuntimeCommand::None;
        };
        self.sent_generation = Some(generation);
        RuntimeCommand::Send(request)
    }

    /// The worker became unusable (crash exhausted retries, or an
    /// evaluation failed against a dead process). Later `debounce_elapsed`
    /// calls no-op until `retry` succeeds.
    pub fn mark_recovery_required(&mut self) {
        self.recovery_required = true;
        self.sent_generation = None;
    }

    /// An explicit Retry: clears recovery and resubmits the last request
    /// immediately, if one was ever made, rather than requiring another
    /// edit just to discover the worker is usable again.
    pub fn retry(&mut self) -> RuntimeCommand {
        self.recovery_required = false;
        let Some(request) = self.last_request.clone() else {
            return RuntimeCommand::None;
        };
        self.sent_generation = Some(request.generation);
        RuntimeCommand::Send(request)
    }

    /// Whether a result for `generation` should still be accepted (drives
    /// cache-acceptance and UI-update gating) — false once a newer
    /// generation has been requested.
    pub fn accepts(&self, generation: u64) -> bool {
        generation == self.latest_generation
    }

    /// A result (success or failure) arrived for `generation`. If it's
    /// still the latest-requested generation, clears `sent_generation` so
    /// a later edit's `content_changed` doesn't send a stale `Cancel` for a
    /// generation that has already finished — a no-op for a stale result
    /// that `accepts` would already reject.
    pub fn mark_result_received(&mut self, generation: u64) {
        if self.accepts(generation) {
            self.sent_generation = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(generation: u64) -> EvaluationRequest {
        EvaluationRequest {
            session_id: "session".into(),
            generation,
            project_root: PathBuf::from("/project"),
            template_id: "test.template".into(),
            template_version: "1".into(),
            inputs_json: Vec::new(),
            output_directory: PathBuf::from("/out"),
            overlays: Vec::new(),
            environment_digest: "sha256:env".into(),
        }
    }

    #[test]
    fn content_changed_then_debounce_elapsed_sends_the_request() {
        let mut runtime = EvaluationRuntime::new();
        assert_eq!(
            runtime.content_changed(request(1)),
            RuntimeCommand::None,
            "nothing was in flight yet, so there is nothing to cancel"
        );
        assert_eq!(
            runtime.debounce_elapsed(1),
            RuntimeCommand::Send(request(1))
        );
    }

    #[test]
    fn a_superseding_edit_cancels_the_in_flight_generation_and_makes_its_debounce_stale() {
        let mut runtime = EvaluationRuntime::new();
        runtime.content_changed(request(1));
        assert_eq!(
            runtime.debounce_elapsed(1),
            RuntimeCommand::Send(request(1))
        );
        // A second edit arrives before generation 1's result comes back.
        assert_eq!(
            runtime.content_changed(request(2)),
            RuntimeCommand::Cancel {
                session_id: "session".into(),
                generation: 1,
            }
        );
        // Generation 1's own debounce timer, still pending, must not fire.
        assert_eq!(runtime.debounce_elapsed(1), RuntimeCommand::None);
        // Only generation 2's does.
        assert_eq!(
            runtime.debounce_elapsed(2),
            RuntimeCommand::Send(request(2))
        );
    }

    #[test]
    fn retry_resubmits_the_last_request_after_recovery_without_another_edit() {
        let mut runtime = EvaluationRuntime::new();
        runtime.content_changed(request(1));
        runtime.debounce_elapsed(1);
        runtime.mark_recovery_required();
        // While recovering, even a matching debounce must not send.
        assert_eq!(runtime.debounce_elapsed(1), RuntimeCommand::None);
        assert_eq!(runtime.retry(), RuntimeCommand::Send(request(1)));
        // Recovery is cleared, so a later debounce for the same generation
        // (e.g. a retried send that itself needs debouncing) works again.
        assert_eq!(
            runtime.debounce_elapsed(1),
            RuntimeCommand::Send(request(1))
        );
    }

    #[test]
    fn retry_with_no_prior_request_does_nothing() {
        let mut runtime = EvaluationRuntime::new();
        runtime.mark_recovery_required();
        assert_eq!(runtime.retry(), RuntimeCommand::None);
    }

    #[test]
    fn mark_result_received_clears_sent_so_a_later_edit_does_not_cancel_a_finished_generation() {
        let mut runtime = EvaluationRuntime::new();
        runtime.content_changed(request(1));
        runtime.debounce_elapsed(1);
        runtime.mark_result_received(1);
        // Generation 1 already finished, so a later edit must not try to
        // cancel it — there is nothing in flight to cancel.
        assert_eq!(runtime.content_changed(request(2)), RuntimeCommand::None);
    }

    #[test]
    fn mark_result_received_ignores_a_stale_generation() {
        let mut runtime = EvaluationRuntime::new();
        runtime.content_changed(request(1));
        runtime.debounce_elapsed(1);
        // Generation 2 supersedes 1 before 1's result arrives.
        runtime.content_changed(request(2));
        runtime.debounce_elapsed(2);
        // A stale result for generation 1 must not clear generation 2's
        // sent-tracking.
        runtime.mark_result_received(1);
        assert_eq!(
            runtime.content_changed(request(3)),
            RuntimeCommand::Cancel {
                session_id: "session".into(),
                generation: 2,
            }
        );
    }

    #[test]
    fn accepts_rejects_a_superseded_generation() {
        let mut runtime = EvaluationRuntime::new();
        runtime.content_changed(request(1));
        assert!(runtime.accepts(1));
        runtime.content_changed(request(2));
        assert!(!runtime.accepts(1));
        assert!(runtime.accepts(2));
    }

    #[test]
    fn two_input_identities_for_the_same_path_are_distinguishable_after_an_edit() {
        let before = InputIdentity {
            template_id: "test.template".into(),
            template_version: "1".into(),
            input_path: PathBuf::from("inputs.json"),
            input_digest: "sha256:before".into(),
            environment_digest: "sha256:env".into(),
        };
        let after = InputIdentity {
            input_digest: "sha256:after".into(),
            ..before.clone()
        };
        assert_ne!(before, after);
        assert_eq!(before.input_path, after.input_path);
    }
}
