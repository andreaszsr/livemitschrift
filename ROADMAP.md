# Roadmap

LiveMitschrift is usable in lectures today. The items below are planned. The
order is a rough priority, not a promise.

## Before the first tagged release

- **Source link in the browser viewer.** Point it to the exact source version a
  server runs, as AGPL-3.0 §13 asks for network services.
- **Signed and notarized macOS download.** This needs an Apple Developer ID; see
  [releasing](docs/releasing.md).
- **First public container image on GHCR.**

## Next

- **Translations.** The UI is currently German only. The plan is to separate UI
  strings and add English, chosen from the system or browser language.
- **Single sign-on for lecturers (OpenID Connect).**
  - Lecturers sign in on the server with their institutional account instead of
    receiving a personal key from an administrator.
  - Only usernames that an administrator has allowed may publish.
  - Students keep reading without an account.
- **Sign-in from the app.** A "Sign in" button opens the browser and the app
  receives a personal key automatically, similar to the OAuth device flow.
- **Viewer performance.** When many readers in Follow mode request the same page
  at once, the server should share one prepared page snapshot between them.

## Not planned

- Windows or Linux desktop builds. The code keeps portable modules separate, but
  only macOS is built and tested.
- Concurrent writers or collaborative editing.
- Multiple backend workers or horizontal scaling.
- An automatic app updater.
