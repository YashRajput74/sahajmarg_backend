import express from "express";
import multer from "multer";
import { handleMessage } from "../services/study.service.js";

const router = express.Router();

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 5 * 1024 * 1024 }
});

router.post("/message", upload.single("file"), handleMessage);

export default router;
