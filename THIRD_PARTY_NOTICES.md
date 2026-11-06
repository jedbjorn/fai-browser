# Third-party notices

FAI Browser is released under the [MIT license](LICENSE). It includes the following third-party material.

## Public Suffix List

- Files: `vendor/public_suffix_list.dat`, and the generated copies in `src/psl-data.js` and `extension/psl-data.js`
  (refreshed with `npm run update-psl`).
- Source: <https://publicsuffix.org/list/public_suffix_list.dat> (the list's own header records the version and commit).
- License: Mozilla Public License 2.0 (<https://mozilla.org/MPL/2.0/>). The list is used unmodified apart from format
  conversion for `psl-data.js`. The MPL applies to those files only; the rest of this project stays MIT. If you redistribute
  these files, keep this notice and the list's license header, and make the MPL text available.

## Development dependencies (not distributed with the package)

`@modelcontextprotocol/sdk` (MIT) and `playwright-core` (Apache-2.0) are used by tests and tooling only. The runtime has no
dependencies.
