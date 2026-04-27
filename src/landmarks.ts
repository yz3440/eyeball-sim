// MediaPipe Face Mesh landmark indices
// Reference: mediapipe/tasks/web/vision/face_landmarker

// Face oval — ordered loop of 36 vertices tracing the face boundary
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
  378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
  162, 21, 54, 103, 67, 109,
];

// Right eye contour — upper lid forward, lower lid backward (subject's right)
export const RIGHT_EYE = [
  33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7,
];

// Left eye contour — upper lid forward, lower lid backward (subject's left)
export const LEFT_EYE = [
  263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390,
  249,
];

// Eye midpoints for computing socket height
// Right eye: upper mid = 159, lower mid = 145
// Left eye: upper mid = 386, lower mid = 374
export const RIGHT_EYE_UPPER_MID = 159;
export const RIGHT_EYE_LOWER_MID = 145;
export const LEFT_EYE_UPPER_MID = 386;
export const LEFT_EYE_LOWER_MID = 374;
