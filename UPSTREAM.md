# Upstream source

This repository incorporates source from [Better Status Page](https://github.com/BElluu/BetterStatusPage), commit `5453e1b537de314c313270a24b1450f137b43a9c`.

The upstream source is licensed under the MIT License. Its copyright notice and license are preserved in `THIRD_PARTY_LICENSE_BetterStatusPage`.

The scheduled HTTP-check design was informed by [cf-workers-status-page](https://github.com/eidam/cf-workers-status-page), including its use of Workers Cron Triggers and HTTP response checks. This fork implements its own probe and D1 persistence; it does not incorporate that project's source code.
