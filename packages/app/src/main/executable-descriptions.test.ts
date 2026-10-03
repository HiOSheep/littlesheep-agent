import { describe, expect, it } from 'vitest'
import { parseVersionDescriptions } from './executable-descriptions.js'

describe('executable descriptions', () => {
  it('reads one description per reported line', () => {
    const output = [
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe\tMicrosoft Edge',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\tGoogle Chrome',
      'C:\\Program Files\\Microsoft Visual Studio\\devenv.exe\tMicrosoft Visual Studio',
    ].join('\r\n')

    const descriptions = parseVersionDescriptions(output)
    expect(descriptions.get('c:\\program files\\microsoft\\edge\\application\\msedge.exe')).toBe('Microsoft Edge')
    expect(descriptions.get('c:\\program files\\google\\chrome\\application\\chrome.exe')).toBe('Google Chrome')
    expect(descriptions.get('c:\\program files\\microsoft visual studio\\devenv.exe')).toBe('Microsoft Visual Studio')
  })

  it('ignores anything that is not a path and a description', () => {
    const descriptions = parseVersionDescriptions([
      '',
      'no tab in this line',
      '\tmissing path',
      'C:\\Tools\\app.exe\t',
      'C:\\Tools\\other.exe\t  Spaced Name  ',
      'C:\\Tools\\中文.exe\t记事本',
    ].join('\n'))

    expect([...descriptions.keys()]).toEqual(['c:\\tools\\other.exe', 'c:\\tools\\中文.exe'])
    expect(descriptions.get('c:\\tools\\other.exe')).toBe('Spaced Name')
    expect(descriptions.get('c:\\tools\\中文.exe')).toBe('记事本')
  })

  it('answers nothing for empty output', () => {
    expect(parseVersionDescriptions('').size).toBe(0)
  })
})
