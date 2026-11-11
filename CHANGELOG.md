# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Contract templates for Gladys energy contracts (one per US time zone,
  delegated pricing): the tariff of the OpenEI Utility Rate Database whose
  label is typed in the contract, priced per half hour (time of use, seasons,
  weekend schedule, tiers per billing period, daily baseline allowances, fuel
  adjustment) and as a current price with its next change.
- Tariffs read at most once a day each, kept in `/data` with their date.
- Quota pause (429, quota at 0, 5xx) and refused key handling, both kept
  across restarts; the key never logged, never in an address.
- Status per tariff: name, utility, effective date, date read, what Gladys
  does not compute (demand charges, minimum bill), the fixed charge to type.
- Buttons: Test, Find tariffs (by ZIP code).
