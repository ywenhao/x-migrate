export interface CookiesFromCurl {
  authToken: string
  ct0: string
}

/** Read only the two required cookie values from a browser's copy-as-curl command. */
export function cookiesFromCurl(input: string): CookiesFromCurl | null {
  const command = input.replace(/\\\r?\n/g, ' ')
  const options =
    /(?:^|\s)(-b|--cookie|-H|--header)(?:\s+|=)(?:'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+))/gi

  for (const match of command.matchAll(options)) {
    const option = match[1].toLowerCase()
    const argument = match[2] ?? match[3]?.replace(/\\(["\\])/g, '$1') ?? match[4] ?? ''
    const cookie =
      option === '-b' || option === '--cookie'
        ? argument
        : /^cookie\s*:/i.test(argument)
          ? argument.replace(/^cookie\s*:\s*/i, '')
          : ''
    if (!cookie) continue

    const values = new Map<string, string>()
    for (const part of cookie.split(';')) {
      const equals = part.indexOf('=')
      if (equals < 0) continue
      const name = part.slice(0, equals).trim()
      const value = part
        .slice(equals + 1)
        .trim()
        .replace(/^"(.*)"$/s, '$1')
      if (name === 'auth_token' || name === 'ct0') values.set(name, value)
    }
    const authToken = values.get('auth_token')
    const ct0 = values.get('ct0')
    if (authToken && ct0) return { authToken, ct0 }
  }
  return null
}
