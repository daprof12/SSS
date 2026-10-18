import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { POSTCODE, PostcodeUnavailable, type PostcodeAdapter } from '../adapters/postcode';
import { AppError, ZodPipe } from '../core/http';

const Nearest = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) });
const Within = Nearest.extend({ radius: z.coerce.number().int().min(10).max(250).default(100) });
const LevelP = z.enum(['state', 'lga', 'district', 'area', 'building']);

/** Wraps the postcode adapter — five cascading levels plus lookup (Wireframes: location filter). */
@Controller('places')
export class PlacesController {
  constructor(@Inject(POSTCODE) private readonly postcode: PostcodeAdapter) {}

  private async safe<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PostcodeUnavailable) {
        throw new AppError(503, 'postcode_unavailable', 'Postcode lookup is not available. Describe the place and we will find it.');
      }
      throw e;
    }
  }

  @Get('lookup')
  async lookup(@Query('postcode') postcode: string) {
    if (!postcode) throw new AppError(422, 'validation_failed', 'Enter a postcode.');
    const b = await this.safe(() => this.postcode.lookup(postcode));
    if (!b) throw new AppError(404, 'postcode_not_found', 'No building found for this postcode. Check it or pick the area by hand.');
    return b;
  }

  @Get('nearest')
  async nearest(@Query(new ZodPipe(Nearest)) q: z.infer<typeof Nearest>) {
    const b = await this.safe(() => this.postcode.nearest(q.lat, q.lng, 50));
    if (!b) throw new AppError(404, 'no_building_nearby', 'We could not find a building here. Pick your building on the map instead.');
    return b;
  }

  /** "Pick your building": every building with a postcode around a point, nearest first. */
  @Get('within')
  async within(@Query(new ZodPipe(Within)) q: z.infer<typeof Within>) {
    const list = await this.safe(() => this.postcode.within(q.lat, q.lng, q.radius));
    return {
      radiusM: Math.min(q.radius, 250),
      buildings: list.map((b) => ({ postcode: b.postcode, label: b.name ?? b.postcode, address: b.address, area: b.areaLabel, lat: b.lat, lng: b.lng, distanceM: b.distanceM })),
    };
  }

  @Get('levels/:level')
  levels(@Param('level', new ZodPipe(LevelP)) level: z.infer<typeof LevelP>, @Query('parent') parent?: string) {
    if (level !== 'state' && !parent) throw new AppError(422, 'parent_required', 'Choose the level above first.');
    return this.safe(() => this.postcode.children(level, parent ?? null));
  }
}
