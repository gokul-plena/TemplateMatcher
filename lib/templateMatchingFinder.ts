let cv: any;

try {
  cv = require('opencv4nodejs-prebuilt-install');
} catch {}

import { Image, ImageFinderInterface, imageResource, MatchRequest, MatchResult, Region, screen } from '@nut-tree/nut-js';
import { ScaleImageHandler } from './handlers/scaleImage';
import { ImageProcessor } from './imageProcessor.class';
import { Mat } from 'opencv4nodejs-prebuilt-install/lib/typings/Mat';
import { OptionsSearchParameterType, CustomMatchRequest, MethodEnum, MethodNameType, CustomConfigType } from './types';
import { OverWritingMatcherHandler } from './handlers/overWriting';
import { ValidationHandler } from './handlers/validation';
import { NonMaximumSuppressionHandler } from './handlers/nonMaximumSuppression';

export default class TemplateMatchingFinder implements ImageFinderInterface {
  private _config: CustomConfigType;

  constructor() {
    this._config = { confidence: 0.8, providerData: { searchMultipleScales: true, scaleSteps: [1, 0.9, 0.8, 0.7, 0.6, 0.5], methodType: MethodEnum.TM_CCOEFF_NORMED, debug: false } };
  }

  getConfig() {
    return this._config;
  }

  setConfig(config: CustomConfigType) {
    this._config = { ...this._config, ...config };
  }

  private async loadNeedle(image: Image | string): Promise<{ data: Mat }> {
    if (typeof image !== 'string') {
      return { data: await ImageProcessor.fromImageWithAlphaChannel(image) };
    } else {
      return { data: await ImageProcessor.fromImageWithAlphaChannel(await imageResource(image)) };
    }
  }

  private async loadHaystack(
    image?: Image | string,
    roi?: Region,
  ): Promise<{
    data: Mat;
    rect: Region | undefined;
    pixelDensity: {
      scaleX: number;
      scaleY: number;
    };
  }> {
    if (typeof image !== 'string' && image) {
      let validRoi = roi ? ValidationHandler.determineMatRectROI(image, ValidationHandler.getIncreasedRectByPixelDensity(roi, image.pixelDensity)) : undefined;

      return {
        data: await ImageProcessor.fromImageWithAlphaChannel(image, validRoi),
        rect: validRoi ? ValidationHandler.determineRegionRectROI(validRoi) : undefined,
        pixelDensity: image.pixelDensity,
      };
    } else {
      if (!image) {
        const imageObj = await screen.grab();
        let validRoi = roi ? ValidationHandler.determineMatRectROI(imageObj, ValidationHandler.getIncreasedRectByPixelDensity(roi, imageObj.pixelDensity)) : undefined;
        const mat = await ImageProcessor.fromImageWithAlphaChannel(imageObj, validRoi);

        return { data: mat, rect: validRoi ? ValidationHandler.determineRegionRectROI(validRoi) : undefined, pixelDensity: imageObj.pixelDensity };
      } else {
        const imageObj = await imageResource(image);
        let validRoi = roi ? ValidationHandler.determineMatRectROI(imageObj, ValidationHandler.getIncreasedRectByPixelDensity(roi, imageObj.pixelDensity)) : undefined;

        return {
          data: await ImageProcessor.fromImageWithAlphaChannel(imageObj, validRoi),
          rect: validRoi ? ValidationHandler.determineRegionRectROI(validRoi) : undefined,
          pixelDensity: imageObj.pixelDensity,
        };
      }
    }
  }

  private async initData<OptionalSearchParameters>(matchRequest: MatchRequest<Image, OptionalSearchParameters> | CustomMatchRequest) {
    const customMatchRequest = matchRequest as CustomMatchRequest;
    const confidence =
      customMatchRequest.providerData && customMatchRequest.providerData?.methodType === MethodEnum.TM_SQDIFF && matchRequest.confidence === 0.99
        ? 0.998
        : (customMatchRequest.providerData && customMatchRequest.providerData?.methodType === MethodEnum.TM_CCOEFF_NORMED) ||
          (customMatchRequest.providerData && customMatchRequest.providerData?.methodType === MethodEnum.TM_CCORR_NORMED && matchRequest.confidence === 0.99)
        ? (this._config.confidence as number)
        : matchRequest.confidence === 0.99 || typeof matchRequest.confidence === 'undefined'
        ? (this._config.confidence as number)
        : matchRequest.confidence;
    const searchMultipleScales =
      customMatchRequest.providerData && 'searchMultipleScales' in customMatchRequest.providerData
        ? customMatchRequest.providerData.searchMultipleScales
        : this._config.providerData?.searchMultipleScales;
    const scaleSteps = customMatchRequest.providerData?.scaleSteps || (this._config.providerData?.scaleSteps as Array<number>);
    const methodType = customMatchRequest.providerData?.methodType || (this._config.providerData?.methodType as MethodNameType);
    const debug = customMatchRequest.providerData?.debug || (this._config.providerData?.debug as boolean);

    const needle = await this.loadNeedle(matchRequest.needle);
    if (!needle || needle.data.empty) {
      throw new Error(`Failed to load ${typeof matchRequest.needle === 'string' ? matchRequest.needle : matchRequest.needle.id}, got empty image.`);
    }
    const haystack = await this.loadHaystack(matchRequest.haystack, customMatchRequest.providerData?.roi);
    if (!haystack || haystack.data.empty) {
      throw new Error(
        `Failed to load ${
          matchRequest && matchRequest.haystack && typeof matchRequest.haystack === 'string' && !matchRequest.haystack ? matchRequest.haystack : (matchRequest.haystack as Image).id
        }, got empty image.`,
      );
    }
    if (searchMultipleScales) {
      ValidationHandler.throwOnTooLargeNeedle(haystack.data, needle.data, scaleSteps[scaleSteps.length - 1]);
    }

    return {
      haystack: haystack,
      needle: needle,
      confidence: confidence,
      scaleSteps: scaleSteps,
      methodType: methodType,
      debug: debug,
      searchMultipleScales: searchMultipleScales,
      roi: customMatchRequest.providerData?.roi,
    };
  }

  public async findMatch<OptionalSearchParameters>(matchRequest: MatchRequest<Image, OptionalSearchParameters> | CustomMatchRequest): Promise<MatchResult<Region>> {
    let { haystack, needle, confidence, scaleSteps, methodType, debug, searchMultipleScales, roi } = await this.initData(matchRequest);

    if (!searchMultipleScales) {
      const matches = await OverWritingMatcherHandler.matchImages(haystack.data, needle.data, methodType, debug);
      const result = await ValidationHandler.getValidatedMatches([matches.data], haystack.pixelDensity, confidence, roi);

      return result[0];
    } else {
      const scaledResults = await ScaleImageHandler.searchMultipleScales(haystack.data, needle.data, confidence, scaleSteps, methodType, debug, true);

      return (await ValidationHandler.getValidatedMatches(scaledResults.length ? [scaledResults[0]] : scaledResults, haystack.pixelDensity, confidence, roi))[0];
    }
  }

  public async findMatches<OptionalSearchParameters>(matchRequest: MatchRequest<Image, OptionalSearchParameters> | CustomMatchRequest): Promise<MatchResult<Region>[]> {
    let matchResults: Array<MatchResult<Region>> = [];
    let { haystack, needle, confidence, scaleSteps, methodType, debug, searchMultipleScales, roi } = await this.initData(matchRequest);

    if (!searchMultipleScales) {
      const overwrittenResults = await OverWritingMatcherHandler.matchImagesByWriteOverFounded(haystack.data, needle.data, confidence, methodType, debug);
      matchResults.push(...overwrittenResults.results);
    } else {
      const scaledResults = await ScaleImageHandler.searchMultipleScales(haystack.data, needle.data, confidence, scaleSteps, methodType, debug);
      matchResults.push(...scaledResults);
    }
    const suppressedMatchResults = NonMaximumSuppressionHandler.filterMatchResult(matchResults);

    return await ValidationHandler.getValidatedMatches(suppressedMatchResults, haystack.pixelDensity, confidence, roi);
  }
}
