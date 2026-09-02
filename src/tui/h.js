// Tiny ergonomic wrapper around `htm` + `react` so we can author Ink screens
// without a JSX build step (same pattern as the megallm CLI).
import { createElement } from 'react';
import htmFactory from 'htm';

export {
  Box,
  Text,
  Newline,
  useApp,
  useInput,
  useStdout,
  render,
} from 'ink';

export { useState, useEffect, useMemo, useRef } from 'react';

export const html = htmFactory.bind(createElement);
