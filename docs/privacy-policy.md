# Privacy policy

_Last updated: 2026-08-02_

This policy describes how the **Fitbit Air MCP** server (the "Service")
handles your data. The Service is open-source software, deployed and
operated by the individual who runs it — there is no company behind it.

## What the Service is

The Service is a [Model Context Protocol](https://modelcontextprotocol.io)
server that lets an AI assistant you already use (such as Claude) read and
write your own health data on your behalf. It sits between that assistant
and the Google Health API. It has no user interface, no accounts of its
own, and no purpose other than relaying data you explicitly ask for.

## What data is accessed

Only the Google Health data covered by the scopes you approve on Google's
consent screen. In practice that is:

- sleep sessions and stages
- activity: steps, distance, calories, active minutes, exercise sessions
- heart rate, resting heart rate, heart-rate zones, heart-rate variability
- body measurements: weight, body fat
- nutrition and hydration logs
- oxygen saturation, respiratory rate, skin temperature, VO2 max
- your Google Health profile settings (units, timezone) and paired devices

Data is read only when your assistant makes a request on your behalf, and
written only when you ask it to log something.

## What is stored, and where

The Service runs on Cloudflare Workers and stores, in Cloudflare KV:

- **OAuth tokens** — the access and refresh tokens Google issues when you
  grant access. These are what allow the Service to act on your behalf.
- **Cached API responses** — health data you have already requested is
  cached for **one hour** to avoid repeating identical calls, then expires
  automatically.

Nothing else is retained. There is no analytics, no logging of your health
data, no profiling, and no database beyond the two uses above.

## Who your data is shared with

Nobody, other than the parties already involved in your own request:

- **Google** — the source of the data, under the grant you approved.
- **The AI assistant you connected** (for example Anthropic's Claude) —
  it receives the data because you asked it a question that needs it.
  Its own privacy policy governs what happens there.

Your data is never sold, never used for advertising, never used to train
any model by the Service, and never shared with any other third party.

## Multi-user deployments

An instance may serve several people. Each person authorizes their own
Google account, and their tokens and cached data are stored under their
own identifier. One user's request can never return another user's data.

## Your controls

- **Revoke access at any time** at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
  Revocation immediately invalidates the stored tokens.
- **Request deletion** of your stored tokens and cache by contacting the
  operator of the instance you use. Cached data expires within an hour
  regardless.

## Security

Tokens are held in Cloudflare KV and are never exposed in responses.
Traffic to Google and to your assistant is over HTTPS. The source code is
public, so the handling described here can be audited directly.

## Changes

Material changes to this policy will be reflected in this document, whose
history is public in the repository.

## Contact

Through the repository this document lives in, or the support email shown
on the Google consent screen.
