---
applyTo: 'src/app.ts'
description: Preserve lobby form autofill separation between player inputs and the fixed admin login.
---

## Lobby Form Autofill

- Keep player name and match code inputs marked as non-credential fields with explicit `name` and `autocomplete` values.
- Keep the fixed `admin` login isolated from player and join inputs. Because the admin UI uses a password-only visible field, preserve a hidden `autocomplete="username"` anchor next to the admin password input so Chrome does not autofill `admin` into the player name or match code fields.