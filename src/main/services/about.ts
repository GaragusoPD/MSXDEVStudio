/**
 * The About box's text.
 *
 * A pure function rather than a string literal inside the dialog call, because
 * this is the one place the application states its own authorship, and
 * MSXDEVStudio's licence asks for exactly that. A test asserts the notice is
 * present, so it cannot quietly disappear in a refactor the way it did before.
 *
 * The third-party lines are the same ones the README credits: MSXgl is
 * CC BY-SA 4.0 and asks for attribution, and the rest are the tools MSXDEVStudio
 * drives rather than reimplements.
 */

export const COPYRIGHT_HOLDER = 'Pablo D. Garaguso'
export const COPYRIGHT_YEAR = 2026

export function aboutTitle(): string {
  return 'About MSXDEVStudio'
}

export function aboutMessage(appVersion: string): string {
  return `MSXDEVStudio ${appVersion}`
}

export function aboutDetail(): string {
  return [
    `Copyright © ${COPYRIGHT_YEAR} ${COPYRIGHT_HOLDER}.`,
    '',
    'A desktop IDE for MSX game development, built around MSXgl.',
    '',
    'Free to use, including for the commercial games you make with it.',
    'Do not sell MSXDEVStudio itself, and credit the author in what you make.',
    '',
    'MSXgl and MSXtk by Guillaume "Aoineko" Blanchard (CC BY-SA 4.0)',
    'SDCC · openMSX · WebMSX by Paulo Peccin · C-BIOS · ayFX by Shiru'
  ].join('\n')
}
