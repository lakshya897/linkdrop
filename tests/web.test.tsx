import { describe, it, expect } from 'vitest';
import App from '../apps/web/src/App';

describe('Web Client React App', () => {
  it('should compile and render standard container elements', () => {
    // Invoke the React component function to get the element description object
    const element = App();

    expect(element).toBeDefined();
    expect(element.type).toBe('div');
    expect(element.props.className).toBe('container');

    // Check that we render the App header
    const children = element.props.children;
    const header = children[0];
    expect(header.type).toBe('header');

    const h1 = header.props.children[0];
    expect(h1.props.children).toBe('LINKDROP');
  });
});
