import express from "express";
import bodyParser from "body-parser";

const { PORT = 3000 } = process.env;

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

// Health check
app.get("/", (_, res) => res.send("OK"));

app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
