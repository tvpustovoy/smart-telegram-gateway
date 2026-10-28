# Contributing

Thank you for your interest in smart-telegram-gateway.

## Issues

Bug reports, questions and ideas go to [GitHub Issues](https://github.com/tvpustovoy/smart-telegram-gateway/issues).
For a bug, please include what you did, what you expected, what happened, and the output of `stg doctor` with secrets
removed.

## Pull requests

1. Build and test before you open a pull request: `npm ci && npm test` (Node.js ≥ 22.19). The suite runs against fakes
   and needs no Telegram bot or API keys.
2. Keep changes focused; add or update tests for the behavior you change.
3. Do not commit secrets, personal data or details of your own installation (bot names, chat ids, home paths).

## License of contributions

The project is licensed under the [Apache License 2.0](LICENSE). Unless you explicitly state otherwise, any
contribution you intentionally submit is licensed under the same terms (section 5 of the license). No separate
contributor agreement or sign-off is required at this time.
