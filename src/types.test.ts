import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { contentText, estimateContentTokens } from './types.js'
import type { ContentPart } from './types.js'

describe('contentText', () => {
  it('passes through a plain string', () => {
    assert.equal(contentText('hello'), 'hello')
  })

  it('extracts text parts from ContentPart[]', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'Look at this:' },
      { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
      { type: 'text', text: 'What do you see?' },
    ]
    assert.equal(contentText(parts), 'Look at this:\nWhat do you see?')
  })

  it('returns empty string for array with no text parts', () => {
    const parts: ContentPart[] = [
      { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
    ]
    assert.equal(contentText(parts), '')
  })
})

describe('estimateContentTokens', () => {
  const charCounter = (text: string) => text.length

  it('delegates to tokenCounter for plain string', () => {
    assert.equal(estimateContentTokens('hello', charCounter), 5)
  })

  it('returns 85 for low-detail image', () => {
    const parts: ContentPart[] = [
      { type: 'image_url', image_url: { url: 'data:...', detail: 'low' } },
    ]
    assert.equal(estimateContentTokens(parts, charCounter), 85)
  })

  it('returns 765 for high-detail image', () => {
    const parts: ContentPart[] = [
      { type: 'image_url', image_url: { url: 'data:...', detail: 'high' } },
    ]
    assert.equal(estimateContentTokens(parts, charCounter), 765)
  })

  it('returns 765 when detail is omitted (conservative)', () => {
    const parts: ContentPart[] = [
      { type: 'image_url', image_url: { url: 'data:...' } },
    ]
    assert.equal(estimateContentTokens(parts, charCounter), 765)
  })

  it('handles mixed text + image array', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'describe this' },  // 13 chars = 13 tokens
      { type: 'image_url', image_url: { url: 'data:...', detail: 'low' } },  // 85 tokens
    ]
    assert.equal(estimateContentTokens(parts, charCounter), 13 + 85)
  })

  it('estimates audio tokens from data length', () => {
    const data = 'a'.repeat(100)
    const parts: ContentPart[] = [
      { type: 'input_audio', input_audio: { data, format: 'wav' } },
    ]
    assert.equal(estimateContentTokens(parts, charCounter), Math.ceil(100 / 4))
  })

  it('estimates video tokens as 765 (single frame)', () => {
    const parts: ContentPart[] = [
      { type: 'video_url', video_url: { url: 'https://example.com/vid.mp4' } },
    ]
    assert.equal(estimateContentTokens(parts, charCounter), 765)
  })
})
