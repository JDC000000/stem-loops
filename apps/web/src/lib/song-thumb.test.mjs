// Run: pnpm --filter web test
// P5.1: a song's thumbnail is derived from its link, never fetched or stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { songThumbnailUrl, youtubeVideoId, YT_THUMB_ORIGIN } from './song-thumb.ts';

const ID = 'dQw4w9WgXcQ';
const THUMB = `https://i.ytimg.com/vi/${ID}/mqdefault.jpg`;

test('the thumbnail comes from i.ytimg.com, mqdefault, built from the video id', () => {
  assert.equal(YT_THUMB_ORIGIN, 'https://i.ytimg.com');
  assert.equal(songThumbnailUrl({ youtube_url: `https://www.youtube.com/watch?v=${ID}` }), THUMB);
});

test('every link shape the app accepts yields the same id', () => {
  for (const u of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://m.youtube.com/watch?v=${ID}&list=PL123`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `youtube.com/watch?v=${ID}`,
  ]) {
    assert.equal(youtubeVideoId(u), ID, u);
  }
});

test('a stored, well-formed video_id is used; a malformed one is ignored', () => {
  assert.equal(songThumbnailUrl({ video_id: 'abcdefghijk', youtube_url: `https://youtu.be/${ID}` }),
    'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg');
  assert.equal(songThumbnailUrl({ video_id: '../../evil', youtube_url: `https://youtu.be/${ID}` }), THUMB);
  assert.equal(songThumbnailUrl({ video_id: '../../evil' }), null);
});

test('no thumbnail for an upload, a blank or foreign link, or a crafted id', () => {
  for (const j of [
    {},
    { youtube_url: null },
    { youtube_url: '' },
    { youtube_url: 'https://evil.example/watch?v=dQw4w9WgXcQ' },
    { youtube_url: 'https://www.youtube.com/watch?v=short' },
    { youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXc%2F' },
    { youtube_url: 'javascript:alert(1)' },
  ]) {
    assert.equal(songThumbnailUrl(j), null, JSON.stringify(j));
  }
});
