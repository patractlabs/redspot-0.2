import { AbstractInt } from '@polkadot/types/codec/AbstractInt';
import { Registry, AnyNumber, Constructor } from '@polkadot/types/types';
import { formatDecimals } from './formatDecimals';

export class CustomBalance extends AbstractInt {
  public static with(
    decimals: number,
    typeName?: string
  ): Constructor<CustomBalance> {
    return class extends CustomBalance {
      constructor(registry: Registry, value?: AnyNumber) {
        super(registry, formatDecimals(value, decimals), 256);
      }

      public toRawType(): string {
        return typeName || super.toRawType();
      }
    };
  }
}
