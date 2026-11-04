export interface Logger {
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const useColor = (stream: NodeJS.WriteStream) => Boolean(stream.isTTY) && !process.env.NO_COLOR;
const paint = (code: number, text: string, stream: NodeJS.WriteStream) =>
  useColor(stream) ? `\x1b[${code}m${text}\x1b[0m` : text;

export function createConsoleLogger({ quiet = false } = {}): Logger {
  const { stdout, stderr } = process;
  return {
    info: (message) => {
      if (!quiet) stdout.write(`${paint(36, "→", stdout)} ${message}\n`);
    },
    success: (message) => {
      if (!quiet) stdout.write(`${paint(32, "✓", stdout)} ${message}\n`);
    },
    warn: (message) => stderr.write(`${paint(33, "!", stderr)} ${message}\n`),
    error: (message) => stderr.write(`${paint(31, "✗", stderr)} ${message}\n`),
  };
}
