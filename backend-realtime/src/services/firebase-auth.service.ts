import { verifyFirebaseIdToken } from '../config/firebase';

export async function verifyToken(token: string, checkRevoked?: boolean) {
  return checkRevoked === undefined ? verifyFirebaseIdToken(token) : verifyFirebaseIdToken(token, checkRevoked);
}
