/**
 * The licence terms the startup gate shows, and the version it records.
 *
 * `LICENSE_VERSION` is compared against `AppState.licenseAccepted`: the gate
 * appears whenever they differ, so bumping the version here is what re-prompts
 * everyone after the terms change. It must match the `Version` line at the top
 * of the LICENSE file — `license.test.ts` asserts exactly that, because a
 * silent drift means new terms nobody ever agreed to.
 *
 * The summary is the plain-language version shown above the full text. It is
 * deliberately not `about.ts`'s two-liner: that one is a notice, this one has
 * to tell a first-time user what they may and may not do before they tick a box.
 */

export const LICENSE_VERSION = '1.0'

export const LICENSE_SUMMARY = {
  may: [
    'Use MSXDEVStudio to make software of any kind, including games you sell. Whatever you make is entirely yours — no rights claimed, no revenue share.',
    'Copy and share MSXDEVStudio itself, unmodified and free of charge.',
    'Fork the source, modify it, and open a pull request. Contributions come in under these same terms.'
  ],
  mayNot: [
    'Sell MSXDEVStudio, charge for access to it, or put it in a paid product, bundle or service.',
    'Ship modified builds of MSXDEVStudio to end users without written permission. Publishing modified source is fine; a rival application built from it is not.',
    'Remove or alter this license, the copyright notice, or the credit below.'
  ],
  must: [
    'Credit the author in software you make with it — "Built with MSXDEVStudio by P.D. Garaguso", or similar wording that names the author, anywhere a user can find it.',
    'Comply with the licenses of MSXgl, SDCC, openMSX and the other tools MSXDEVStudio drives. They are not covered by this license.'
  ]
} as const
