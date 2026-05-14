// firebase.config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBWdnTouXC9UjgjsZbB-_bQbt6FdY5JRTw",
  authDomain: "arriendos-musicala.firebaseapp.com",
  projectId: "arriendos-musicala",
  storageBucket: "arriendos-musicala.firebasestorage.app",
  messagingSenderId: "730686491081",
  appId: "1:730686491081:web:e274be83bd7f3abb978018"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
export const db = getFirestore(app);
