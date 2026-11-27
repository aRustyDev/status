# Cloudflare subscribers

Subscribers use their Cloudflare Access identity and a deployment-approved email address. An operator enables email subscriptions and selects the event types and component scoping available to readers. Subscribers confirm their address before receiving published incident and maintenance updates. They can manage preferences and unsubscribe from the status page while signed in.

Configure the operations Worker with `SUBSCRIBERS_READY=true`, `SUBSCRIBER_EMAIL_READY=true`, a verified `SUBSCRIBER_EMAIL_FROM`, an HTTPS origin in `SUBSCRIBER_PUBLIC_URL`, and `SUBSCRIBER_EMAIL_DESTINATIONS` in the same approved-recipient format as notification channels. Bind `SUBSCRIBER_EMAIL` with matching allowed sender and recipient addresses. Apply the subscriber migrations and configure a scheduled trigger on the operations Worker before enabling delivery. Keep these environment-specific values outside the repository.

The subscriber sender has its own readiness flag and binding. Disable `SUBSCRIBER_EMAIL_READY` to stop new dispatches. A send that passed its final eligibility check can finish while a subscriber is being removed or unsubscribed. An ambiguous email send is recorded as failed and is not retried automatically. Delivery acceptance does not establish inbox receipt.

Subscriber addresses and confirmation-token digests are stored in D1. Deleting a subscriber removes current subscriber and delivery rows. Existing D1 exports and backups can retain earlier copies until their normal expiration.
