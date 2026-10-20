export interface CommandToken {
  value: string;
  start: number;
  end: number;
}

/** Parse only a single literal argv command. Shell expansion, pipelines, and
 * compound commands need review; treating them as argv could change behavior. */
export function literalArgv(command: string): CommandToken[] | undefined {
  const tokens: CommandToken[] = [];
  let value = '';
  let start = 0;
  let quote = '';
  let active = false;
  for (let i = 0; i < command.length; i++) {
    const character = command[i];
    if (quote) {
      if (character === quote) {
        quote = '';
      } else if (
        character === '\\' ||
        (quote === '"' && (character === '$' || character === '`'))
      ) {
        return undefined;
      } else {
        value += character;
      }
    } else if (character === "'" || character === '"') {
      if (!active) {
        start = i;
      }
      quote = character;
      active = true;
    } else if (character === '\n' || character === '\r') {
      return undefined;
    } else if (/\s/.test(character)) {
      if (active) {
        tokens.push({ value, start, end: i });
      }
      active = false;
      value = '';
    } else if (/[|&;<>($`\\)]/.test(character)) {
      return undefined;
    } else {
      if (!active) {
        start = i;
      }
      value += character;
      active = true;
    }
  }
  if (quote) {
    return undefined;
  }
  if (active) {
    tokens.push({ value, start, end: command.length });
  }
  return tokens;
}

/** Read literal command lists without executing a shell. Token offsets refer
 * to the original script so callers can preserve its quoting and spacing. */
export function literalCommands(command: string): CommandToken[][] | undefined {
  const commands: CommandToken[][] = [];
  let quote = '';
  let start = 0;
  const append = (end: number) => {
    const tokens = literalArgv(command.slice(start, end));
    if (!tokens?.length) {
      return false;
    }
    for (const token of tokens) {
      token.start += start;
      token.end += start;
    }
    commands.push(tokens);
    return true;
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === '\\') {
      return undefined;
    }
    if (quote) {
      if (char === quote) {
        quote = '';
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#') {
      return undefined;
    } else if (
      char === ';' ||
      command.slice(index, index + 2) === '&&' ||
      command.slice(index, index + 2) === '||'
    ) {
      if (!append(index)) {
        return undefined;
      }
      if (char !== ';') {
        index++;
      }
      start = index + 1;
    }
  }
  return !quote && append(command.length) ? commands : undefined;
}
