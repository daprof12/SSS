// KYC adapter (TRD: pilot Smile ID and Dojah). We keep only the result, a
// provider reference and a masked ID — never the raw NIN or BVN.

export interface KycStartInput {
  idType: 'nin' | 'bvn';
  idNumber: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
}

export type KycResult =
  | { status: 'verified'; providerRef: string; idMasked: string; selfieMatch: number }
  | { status: 'failed'; providerRef: string; idMasked: string; reason: 'id_not_found' | 'details_mismatch' | 'face_mismatch' | 'liveness_failed' }
  | { status: 'manual_review'; providerRef: string; idMasked: string };

export interface KycAdapter {
  readonly name: string;
  verify(input: KycStartInput, selfie: { liveness: boolean }): Promise<KycResult>;
}

export const KYC = Symbol('KYC');

export const maskId = (id: string) => `${'•'.repeat(Math.max(0, id.length - 4))}${id.slice(-4)}`;

/**
 * Deterministic mock for tests and demos:
 *  - ID ending 0000 → not found;  ending 1111 → details mismatch;
 *  - ending 2222 → manual review; liveness false → liveness failed; anything else → verified.
 */
export class MockKycAdapter implements KycAdapter {
  readonly name = 'mock';
  private n = 0;

  async verify(input: KycStartInput, selfie: { liveness: boolean }): Promise<KycResult> {
    if (!/^\d{11}$/.test(input.idNumber)) throw new Error('ID number must be 11 digits');
    const providerRef = `mock_kyc_${++this.n}_${Date.now()}`;
    const idMasked = maskId(input.idNumber);
    if (!selfie.liveness) return { status: 'failed', providerRef, idMasked, reason: 'liveness_failed' };
    if (input.idNumber.endsWith('0000')) return { status: 'failed', providerRef, idMasked, reason: 'id_not_found' };
    if (input.idNumber.endsWith('1111')) return { status: 'failed', providerRef, idMasked, reason: 'details_mismatch' };
    if (input.idNumber.endsWith('2222')) return { status: 'manual_review', providerRef, idMasked };
    return { status: 'verified', providerRef, idMasked, selfieMatch: 0.97 };
  }
}
