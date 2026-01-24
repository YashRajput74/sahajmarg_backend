/* import express from "express";
import multer from "multer";
import { handleStudyMessage } from "../services/study.service.js";

const router = express.Router();
const upload = multer({ dest: "uploads/" });

router.post("/message", upload.single("file"), handleStudyMessage);
router.post("/message/guest", handleStudyMessage);

export default router;
 */