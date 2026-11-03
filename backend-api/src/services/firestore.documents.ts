import type { Timestamp } from 'firebase-admin/firestore';

export interface UserDocument {
  uid: string;
  nombre: string;
  apellido: string;
  email: string;
  username: string;
  avatarUrl: string;
}

export interface UsernameDocument {
  usernameKey: string;
  uid: string;
}

export interface RoomDocument {
  roomId: string;
  ownerId: string;
  name: string;
  createdAt: Timestamp;
}

export interface MemberDocument {
  uid: string;
  roomId: string;
  role: 'host' | 'member';
  joinedAt: Timestamp;
}

export interface MessageDocument {
  messageId: string;
  roomId: string;
  senderId: string;
  text: string;
  createdAt: Timestamp;
}
