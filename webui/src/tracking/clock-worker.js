// Message delivery stays independent of animation frames in hidden documents.
setInterval(() => self.postMessage(null), 34);
