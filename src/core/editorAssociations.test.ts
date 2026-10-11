import { describe, expect, test } from 'bun:test';
import {
  AGENTS_HTML_READER,
  AGENTS_MARKDOWN_EDITOR,
  normalizeEditorAssociations,
  withReaderEditorAssociations,
} from './editorAssociations';

describe('normalizeEditorAssociations', () => {
  test('keeps the object map VS Code expects, minus non-string values; non-objects read as empty', () => {
    expect(normalizeEditorAssociations(undefined)).toEqual({});
    expect(normalizeEditorAssociations('nope')).toEqual({});
    expect(normalizeEditorAssociations({ '*.md': AGENTS_MARKDOWN_EDITOR, '*.pdf': 'pdf.preview', '*.bad': 12, '*.empty': '' }))
      .toEqual({ '*.md': AGENTS_MARKDOWN_EDITOR, '*.pdf': 'pdf.preview' });
  });

  test('migrates the legacy array shape AGI EXT used to write', () => {
    expect(
      normalizeEditorAssociations([
        { viewType: AGENTS_MARKDOWN_EDITOR, filenamePattern: '*.md' },
        { viewType: 'pdf.preview', filenamePattern: '*.pdf' },
        { viewType: 'broken' },
        null,
      ])
    ).toEqual({
      '*.md': AGENTS_MARKDOWN_EDITOR,
      '*.pdf': 'pdf.preview',
    });
  });
});

describe('withReaderEditorAssociations', () => {
  test('enabling maps md and html/htm to the Reader, replacing a prior md entry and keeping others', () => {
    expect(withReaderEditorAssociations({ '*.pdf': 'pdf.preview', '*.md': 'default' }, true)).toEqual({
      '*.pdf': 'pdf.preview',
      '*.md': AGENTS_MARKDOWN_EDITOR,
      '*.html': AGENTS_HTML_READER,
      '*.htm': AGENTS_HTML_READER,
    });
  });

  test('disabling pins md and html patterns to default', () => {
    expect(
      withReaderEditorAssociations(
        { '*.md': AGENTS_MARKDOWN_EDITOR, '*.html': AGENTS_HTML_READER, '*.htm': AGENTS_HTML_READER, '*.pdf': 'pdf.preview' },
        false
      )
    ).toEqual({ '*.md': 'default', '*.html': 'default', '*.htm': 'default', '*.pdf': 'pdf.preview' });
  });
});
