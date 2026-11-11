import { assertDeletionTestEnvironment } from '../config/deletion-test';
assertDeletionTestEnvironment();
console.log(`Deletion tests: Authentication Emulator ${process.env.FIREBASE_AUTH_EMULATOR_HOST}`);
