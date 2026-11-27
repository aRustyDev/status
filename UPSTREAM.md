# Upstream source

This repository incorporates source from [Better Status Page](https://github.com/BElluu/BetterStatusPage), commit `5453e1b537de314c313270a24b1450f137b43a9c`.

The upstream source is licensed under the MIT License. Its copyright notice and license are preserved in `THIRD_PARTY_LICENSE_BetterStatusPage`.

The Cloudflare monitor editor reuses the incorporated upstream `TagsSection` and sidebar for coloured labels and existing-tag suggestions. Monitor tag storage and API handling are adapted to the Workers and D1 architecture; Gatus-managed monitors remain read-only, and tag-based subscriptions are not supported by this profile.

The Cloudflare Request panel reuses the upstream body editor and sidebar, with deployment-approved plaintext headers and Vault Secure Value selectors adapted to the Workers request policy. The upstream free-form header editor remains available in the Node profile.

The scheduled HTTP-check design was informed by [cf-workers-status-page](https://github.com/eidam/cf-workers-status-page), including its use of Workers Cron Triggers and HTTP response checks. This fork implements its own probe and D1 persistence; it does not incorporate that project's source code.

The Cloudflare Vault screen adapts the layout and shared modal components of the upstream `@better-forge/ui` Vault page. The upstream page is coupled to the Node API client and offers reveal and HashiCorp operations that the Workers API does not implement, so it cannot be used unchanged. The adapted screen uses the Cloudflare API client, local encrypted vaults, and write-only secret creation and rotation. External vault providers and secret reveal remain unavailable.

The Cloudflare monitor Alerts panel reuses the incorporated upstream `ChannelsSection`; monitor assignments and delivery are adapted to Workers and D1. The Cloudflare Notifications screen reuses the upstream page and editor controls with an adapted Cloudflare channel editor. The upstream channel editor assumes the Node API, many delivery providers, direct credentials and alert policies that the Workers implementation does not support. The adapted editor limits configuration to deployment-approved email recipients and HTTPS webhooks with Vault Secure Value tokens; other providers remain unavailable.

The Cloudflare monitor Depends on panel reuses the incorporated upstream dependency selector. Relationships, scheduled status evaluation and notification suppression are adapted to Workers and D1. Administrators can select Cloudflare-managed monitors as dependencies.

The Cloudflare Actions screen adapts the upstream sortable action list, modal shell, controls, and Vault-selection pattern. The Cloudflare editor retains its own request and monitor fields because its API and supported action model differ from the upstream Node editor. Its Node action editor supports arbitrary HTTP templates and direct credentials that the Workers runtime does not expose; the adapted page offers only deployment-approved HTTPS POST actions with write-only Vault tokens and explicit monitor-state triggers.

The Cloudflare monitor Actions panel reuses the upstream `ActionsSection`, adapted to accept Cloudflare UUID action identifiers as well as upstream numeric identifiers. Its action links are saved separately from monitor settings with a version check, and new monitors are saved before links can be configured. Action execution and persistence use the Workers and D1 implementation; Gatus-managed monitors remain read-only.

The Cloudflare Static Fallback screen adapts the upstream settings and status presentation. The Node implementation accepts S3 credentials and publishes a public copy. This profile uses a private, deployment-bound R2 bucket and a separate Access-protected Worker. The status reader reuses the upstream snapshot data source and banner.

The Cloudflare Delivery History screen adapts the upstream tabbed history, filters, expandable rows and pagination to the Workers API and D1 delivery records. The upstream history components depend on the Node API's numeric identifiers, response formats and retry semantics, so the Cloudflare screen uses those UI patterns with Cloudflare-specific data and capability states. Subscriber history remains unavailable until subscriber delivery is implemented.

The Cloudflare Users screen adapts the upstream Users table, role buttons, and shared components. The upstream page is coupled to Node account, password, and SSO APIs; Cloudflare Access manages identity and sign-in, while the Workers API manages application roles.
