# Issue-to-merge lifecycle

`archon-lifecycle` composes the existing shared ship (including independent review,
validation and delivery correction loops), runtime verification, a fresh holdout,
discoveries, merge queue and, optionally, deployment. Inputs are `target`, absolute
`scenario` and `holdout` paths, `merge_mode`, `discovery_publication`, `publish`, `intake_label`,
and the optional `deploy`/`health`/`identity` commands forwarded to `archon-deploy`
after a confirmed merge. Modes default to approval and preview; select auto
explicitly for unattended publication/merge.

**Backlog intake.** An empty `target` makes the first node select the oldest open
issue in the origin repository that no earlier run has touched: no `archon-*`
state label and no open pull request naming it. That is deterministic `gh`
reading; whether the issue is worth building stays with triage. Set
`publish=true` so triage's state label marks the issue as touched, otherwise an
unattended schedule re-selects the same issue every tick. Nothing untouched
completes the run with nothing to do.

Set `intake_label=factory` on the project schedule to accept only issues carrying
the exact `factory` label. Intake queries GitHub with that label and checks exact
membership in the response. Empty `intake_label` keeps unrestricted backlog intake;
an explicit `target` bypasses intake and ignores the label. Both issue and open PR
reads cover all pages, so selection uses the lowest eligible issue number across
the backlog. Queries use the current GitHub.com `origin`, including when `GH_REPO`
or `GH_HOST` points elsewhere. A failed GitHub read fails the node without selecting
an issue.

Project runtime environments are managed by the ordinary factory resource host.
The workflow requires evidence that the app being verified is the delivered
revision. An application failure at the unchanged PR head gets one shared archon-deliver
repair, with independent review, then fresh runtime and holdout verification.
Missing evidence, identity drift, infrastructure failure or a second failed
verification holds the handoff. The loop is bounded and visible in the graph.

No factory stage dispatcher, provider subprocess, forge extension or native
scheduler is required. Scheduling invokes this whole workflow externally.
Intake regression tests run with `bun test ./.archon/scripts/__tests__/lifecycle-intake.test.ts`.
They execute the Python script against fake GitHub and Git transports; they do not
run AI stages or publish changes.
