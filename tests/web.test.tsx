import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import App from '../apps/web/src/App';

describe('Web Client React App', () => {
  it('should compile and render standard container elements', () => {
    const html = renderToString(React.createElement(App));
    expect(html).toContain('LinkDrop');
    expect(html).toContain('Share Anything.');
  });
});
