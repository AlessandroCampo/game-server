import express, { Request, Response } from 'express';  // Ensure correct types for Express
import { createServer } from 'http';
import { Server } from 'socket.io';
import { PrismaClient } from './generated/prisma'; // Prisma client import
import cors from 'cors';
import path from 'path';
import multer from 'multer';
import fs from 'fs';
import dotenv from 'dotenv';

require('dotenv').config();

const app = express();
const httpServer = createServer(app);
const prisma = new PrismaClient();


app.use((req, res, next) => {
    res.setHeader('ngrok-skip-browser-warning', 'true');
    next();
});

app.use(express.json());
app.use(
    '/uploads',
    express.static(path.join(__dirname, '..', 'public', 'uploads'))
);

app.use(cors());



const storage = multer.diskStorage({
    destination: (
        req: Request,
        file: Express.Multer.File,
        cb: (error: Error | null, destination: string) => void
    ) => {
        cb(null, path.join(__dirname, '..', 'public', 'uploads'));
    },

    filename: (
        req: Request,
        file: Express.Multer.File,
        cb: (error: Error | null, filename: string) => void
    ) => {
        const ext = path.extname(file.originalname);
        const name = path.basename(file.originalname, ext);
        cb(null, `${name}-${Date.now()}${ext}`);
    },
});
const upload = multer({ storage });
/**
 * GET: Fetch all effects and keywords
 */


// POST endpoint for creating a new effect


// GET endpoint for fetching all cards with their effects & keywords
app.get('/cards', async (_req: Request, res: Response): Promise<void> => {
    try {
        // Fetch cards, include join‐table entries, and pull the related records
        const cards = await prisma.card.findMany({
            include: {
                cardKeywords: {
                    include: { keyword: true }
                }
            }
        })

        // Optionally, flatten the relations into plain arrays:
        const result = cards.map(card => ({
            ...card,
            image_url: `${process.env.BASE_URL}/uploads/${card.id}.jpg`,
            keywords: card.cardKeywords.map(key => key.keyword)
        }))

        res.json(result)
    } catch (err) {
        console.error('Fetch cards error', err)
        res.status(500).json({ error: 'Failed to fetch cards' })
    }
})


app.get('/card-data', async (_req: Request, res: Response): Promise<void> => {
    try {
        const [effects] = await Promise.all([
            prisma.keyword.findMany(),
        ]);
        res.json({ effects });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch card data' });
    }
});


app.post('/keywords', async (req: Request, res: Response): Promise<void> => {
    const { name } = req.body;
    try {
        const existingKeyword = await prisma.keyword.findUnique({ where: { name } });
        if (existingKeyword) {
            res.status(400).json({ error: 'Keyword with this name already exists' });
            return;
        }
        const createdKeyword = await prisma.keyword.create({ data: { name } });
        res.status(201).json(createdKeyword);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create keyword' });
    }
});

app.get('/keywords', async (req, res) => {
    try {
        const keywords = await prisma.keyword.findMany(); // or whatever your Prisma model is called
        res.json(keywords);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch keywords' });
    }
});



// Change this route to handle multipart/form-data and call multer middleware
app.post('/create-card', upload.single('image'), async (
    req: Request & { file?: Express.Multer.File },
    res: Response
): Promise<void> => {
    try {
        const imageFile = req.file;
        if (!imageFile) {
            res.status(400).json({ error: 'Image file is required' });
            return;
        }

        const {
            name,
            attack,
            defense,
            cost,
            type,
            color,
            subtype,
            rarity,
            effectName,
            effectType,
            effectText,
            keywordIds = [],
        } = req.body;

        // Prepare keyword relations
        const cardKeywords = (Array.isArray(keywordIds) ? keywordIds : [keywordIds]).map((id) => ({
            keyword: { connect: { id: Number(id) } },
        }));

        // Create card in DB
        const createdCard = await prisma.card.create({
            data: {
                name,
                attack: attack ? Number(attack) : null,
                defense: defense ? Number(defense) : null,
                cost: Number(cost),
                type,
                color,
                subtype: subtype || null,
                rarity,
                effectName,
                effectType,
                effectText,
                cardKeywords: { create: cardKeywords },
            },
        });

        // Rename the uploaded image file to use the card's ID
        const fileExt = path.extname(imageFile.originalname);
        const newFilename = `${createdCard.id}${fileExt}`;
        const oldPath = path.join(__dirname, '../public/uploads', imageFile.filename);
        const newPath = path.join(__dirname, '../public/uploads', newFilename);
        fs.renameSync(oldPath, newPath);

        res.status(201).json({
            ...createdCard,
            imageUrl: `/uploads/${newFilename}`,
        });
    } catch (err) {
        console.error('Create card error', err);
        res.status(500).json({ error: 'Failed to create card' });
    }
});




const io = new Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});

const diceRoll = () => {
    const myPlayerRoll = Math.floor(Math.random() * 6);
    const enemyPlayerRoll = Math.floor(Math.random() * 6);
    return myPlayerRoll >= enemyPlayerRoll ? 0 : 1;
};

const waitingQueue: string[] = [];

io.on('connection', (socket) => {
    console.log('A player connected:', socket.id);

    if (waitingQueue.length > 0) {
        const opponentSocketId = waitingQueue.shift();
        if (opponentSocketId && io.sockets.sockets.get(opponentSocketId)) {
            const room = `room-${opponentSocketId}-${socket.id}`;
            socket.join(room);
            const opponentSocket = io.sockets.sockets.get(opponentSocketId);
            opponentSocket?.join(room);

            const startingPlayerIndex = diceRoll();
            const players = [opponentSocketId, socket.id];
            const startingPlayerId = players[startingPlayerIndex];

            io.to(room).emit('game-start', {
                room,
                players,
                startingPlayerId,
            });
        }
    }

    socket.on('play-card', (data) => {
        socket.to(data.room).emit('opponent-played-card', data.card);
    });

    socket.on('attack', (data) => {
        socket.to(data.room).emit('opponent-attack', data);
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        const index = waitingQueue.indexOf(socket.id);
        if (index !== -1) {
            waitingQueue.splice(index, 1);
        }
    });
});

app.get('/', (_req: Request, res: Response) => {
    res.send('Socket.IO Game Server is running!');
});

httpServer.listen(3000, () => {
    console.log('Server listening on http://localhost:3000');
});
