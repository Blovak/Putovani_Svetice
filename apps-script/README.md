# Apps Script backend

This directory contains the source of the Google Apps Script backend used by
Světické kilometrobraní. It is tracked here as a reviewable backup; the live
Apps Script project remains the deployment source of truth.

The manifest intentionally contains only OAuth scopes and web-app settings.
Runtime secrets such as `AUTH_PEPPER` stay in Apps Script Properties and must
never be committed.

Production deployments must be made with the dedicated `putovani` clasp
profile so the web app continues to execute as `putovani.svetice@gmail.com`:

```sh
clasp --user putovani push
```

The current production release is Apps Script version 30. It includes the
dedicated, idempotent daily admin usage report scheduled after 01:00 in the
`Europe/Prague` time zone and a separately precomputed display distance that is
refreshed every five minutes.
