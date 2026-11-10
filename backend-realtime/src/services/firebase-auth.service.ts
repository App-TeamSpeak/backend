import { verifyFirebaseIdToken } from '../config/firebase';

export async function verifyToken(token: string) {
  return verifyFirebaseIdToken(token);
}
