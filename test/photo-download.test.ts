import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { buildSurveyPhotoZip, safeDownloadName } from '../src/photos/download';
import type { Survey } from '../src/types';

describe('survey photo ZIP', () => {
  it('keeps exact photo bytes, duplicate names and camera metadata', async () => {
    const photos = [1, 2].map((n) => ({ id: `p${n}`, surveyId: 's', timestamp: 123,
      image: 'data:image/jpeg;base64,/9j/AA==', importInfo: { fileName: '../same.jpg' },
      cameraPosition: { lat: 34, lon: 135 }, cameraHeading: { bearing: 90 } }));
    const survey = { id: 's', name: '現地調査', createdAt: 123, photos } as unknown as Survey;
    const progress: number[] = [];
    const blob = await buildSurveyPhotoZip(survey, (done) => progress.push(done));
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(files)).toEqual(['photos/0001-_same.jpg', 'photos/0002-_same.jpg', 'photos.json']);
    expect([...files['photos/0001-_same.jpg']]).toEqual([255, 216, 255, 0]);
    const metadata = JSON.parse(strFromU8(files['photos.json']));
    expect(metadata.photos[0].cameraPosition).toEqual({ lat: 34, lon: 135 });
    expect(metadata.photos[0].cameraHeading.bearing).toBe(90);
    expect(metadata.photos[0].image).toBeUndefined();
    expect(progress).toEqual([1, 2]);
  });
  it('rejects an empty survey or unavailable image data', async () => {
    await expect(buildSurveyPhotoZip({ photos: [] } as unknown as Survey)).rejects.toThrow('No photos');
    await expect(buildSurveyPhotoZip({ photos: [{ image: 'https://example.com/photo.jpg' }] } as unknown as Survey)).rejects.toThrow('format');
    expect(safeDownloadName('../../')).not.toContain('/');
  });
});
