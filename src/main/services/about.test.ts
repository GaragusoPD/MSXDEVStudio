import { describe, expect, it } from 'vitest'
import { aboutDetail, aboutMessage, COPYRIGHT_HOLDER, COPYRIGHT_YEAR } from './about'

describe('the About box', () => {
  it('names the author, which the licence asks for and the box used to omit', () => {
    const detail = aboutDetail()
    expect(detail).toContain(COPYRIGHT_HOLDER)
    expect(detail).toContain(`Copyright © ${COPYRIGHT_YEAR}`)
  })

  it('states the two terms a user has to know', () => {
    const detail = aboutDetail()
    expect(detail).toMatch(/do not sell msxdevstudio itself/i)
    expect(detail).toMatch(/credit the author/i)
  })

  it('credits MSXgl with its licence, which asks for attribution too', () => {
    const detail = aboutDetail()
    expect(detail).toContain('MSXgl')
    expect(detail).toContain('Aoineko')
    expect(detail).toContain('CC BY-SA 4.0')
  })

  it('puts the application version in the headline', () => {
    expect(aboutMessage('0.1.0')).toBe('MSXDEVStudio 0.1.0')
  })
})
