const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);

// Serve static files from public folder
app.use(express.static("public"));

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store active games and players
const games = new Map();
const players = new Map();

// Vocabulary data
const vocabulary = {
    easy: [
        { 
            word: "Happy", 
            definition: "Feeling or showing pleasure or contentment",
            incorrect: ["Sad", "Angry", "Tired", "Bored"],
            difficulty: "easy"
        },
        { 
            word: "Big", 
            definition: "Of considerable size or extent",
            incorrect: ["Small", "Tiny", "Short", "Narrow"],
            difficulty: "easy"
        }
    ],
    medium: [
        { 
            word: "Eloquent", 
            definition: "Fluent or persuasive in speaking or writing",
            incorrect: ["Difficult to understand", "Rude in speech", "Quiet and reserved", "Using few words"],
            difficulty: "medium"
        }
    ]
};

// Handle WebSocket connections
wss.on("connection", (ws, req) => {
    console.log("New WebSocket connection");
    
    // Generate unique player ID
    const playerId = Date.now() + Math.random().toString(36).substr(2, 9);
    players.set(playerId, { ws, playerId });
    
    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message.toString());
            console.log("Received:", data.type);
            
            handleMessage(playerId, data);
            
        } catch (error) {
            console.error("Error parsing message:", error);
            ws.send(JSON.stringify({ 
                type: "error", 
                message: "Invalid message format" 
            }));
        }
    });
    
    ws.on("close", () => {
        console.log("Player disconnected:", playerId);
        handlePlayerDisconnect(playerId);
        players.delete(playerId);
    });
    
    ws.on("error", (error) => {
        console.error("WebSocket error:", error);
    });
    
    // Send connection confirmation
    ws.send(JSON.stringify({ 
        type: "connected", 
        playerId: playerId,
        message: "Connected to game server" 
    }));
});

function handleMessage(playerId, data) {
    const player = players.get(playerId);
    if (!player) return;
    
    switch(data.type) {
        case "create_game":
            createGame(player, data);
            break;
            
        case "join_game":
            joinGame(player, data);
            break;
            
        case "chat_message":
            handleChatMessage(player, data);
            break;
            
        case "start_game":
            startGame(player, data);
            break;
            
        case "submit_answer":
            submitAnswer(player, data);
            break;
    }
}

function createGame(player, data) {
    const gameCode = generateGameCode();
    const game = {
        code: gameCode,
        hostId: player.playerId,
        players: [{
            id: player.playerId,
            name: data.playerName || "Player",
            score: 0,
            isHost: true,
            ws: player.ws
        }],
        settings: data.settings || { rounds: 5, difficulty: "medium", timePerQuestion: 30 },
        status: "waiting",
        chat: []
    };
    
    games.set(gameCode, game);
    
    // Update player info
    player.gameCode = gameCode;
    player.name = data.playerName || "Player";
    
    // Send success message to creator
    player.ws.send(JSON.stringify({
        type: "game_created",
        gameCode: gameCode,
        players: game.players,
        settings: game.settings
    }));
    
    console.log(`Game created: ${gameCode} by ${player.name}`);
}

function joinGame(player, data) {
    const gameCode = data.gameCode.toUpperCase();
    const game = games.get(gameCode);
    
    if (!game) {
        player.ws.send(JSON.stringify({
            type: "error",
            message: "Game not found. Check the code!"
        }));
        return;
    }
    
    if (game.status !== "waiting") {
        player.ws.send(JSON.stringify({
            type: "error",
            message: "Game already started"
        }));
        return;
    }
    
    // Add player to game
    const newPlayer = {
        id: player.playerId,
        name: data.playerName || "Friend",
        score: 0,
        isHost: false,
        ws: player.ws
    };
    
    game.players.push(newPlayer);
    
    // Update player info
    player.gameCode = gameCode;
    player.name = data.playerName || "Friend";
    
    // Notify ALL players in the game
    game.players.forEach(p => {
        if (p.ws.readyState === 1) { // WebSocket.OPEN
            p.ws.send(JSON.stringify({
                type: "player_joined",
                player: newPlayer,
                players: game.players,
                playerCount: game.players.length
            }));
        }
    });
    
    console.log(`${newPlayer.name} joined game ${gameCode}`);
}

function handleChatMessage(player, data) {
    const gameCode = player.gameCode;
    if (!gameCode) return;
    
    const game = games.get(gameCode);
    if (!game) return;
    
    // Add to chat history
    game.chat.push({
        player: player.name,
        message: data.message,
        timestamp: new Date().toISOString()
    });
    
    // Broadcast to all players
    game.players.forEach(p => {
        if (p.ws.readyState === 1) {
            p.ws.send(JSON.stringify({
                type: "chat_message",
                player: player.name,
                message: data.message
            }));
        }
    });
}

function startGame(player, data) {
    const gameCode = player.gameCode;
    if (!gameCode) return;
    
    const game = games.get(gameCode);
    if (!game) return;
    
    // Check if player is host
    const isHost = game.players.find(p => p.id === player.playerId)?.isHost;
    if (!isHost) return;
    
    // Check if enough players
    if (game.players.length < 2) {
        player.ws.send(JSON.stringify({
            type: "error",
            message: "Need at least 2 players to start!"
        }));
        return;
    }
    
    game.status = "playing";
    game.currentRound = 1;
    
    // Notify all players
    game.players.forEach(p => {
        if (p.ws.readyState === 1) {
            p.ws.send(JSON.stringify({
                type: "game_started",
                settings: game.settings,
                players: game.players
            }));
        }
    });
    
    console.log(`Game ${gameCode} started with ${game.players.length} players`);
    
    // Start first round after 3 seconds
    setTimeout(() => {
        sendNewQuestion(gameCode);
    }, 3000);
}

function sendNewQuestion(gameCode) {
    const game = games.get(gameCode);
    if (!game || game.status !== "playing") return;
    
    // Get random question based on difficulty
    const difficulty = game.settings.difficulty;
    const questions = vocabulary[difficulty] || vocabulary.medium;
    const question = questions[Math.floor(Math.random() * questions.length)];
    
    // Prepare options
    const options = [question.definition, ...question.incorrect];
    shuffleArray(options);
    
    // Send question to all players
    game.players.forEach(p => {
        if (p.ws.readyState === 1) {
            p.ws.send(JSON.stringify({
                type: "new_question",
                question: question.word,
                options: options,
                correctAnswer: question.definition,
                round: game.currentRound,
                totalRounds: game.settings.rounds
            }));
        }
    });
    
    // Set timer for answers
    game.questionTimeout = setTimeout(() => {
        endQuestion(gameCode);
    }, (game.settings.timePerQuestion || 30) * 1000);
}

function submitAnswer(player, data) {
    const gameCode = player.gameCode;
    if (!gameCode) return;
    
    const game = games.get(gameCode);
    if (!game || game.status !== "playing") return;
    
    // Update player score if correct
    const playerInGame = game.players.find(p => p.id === player.playerId);
    if (playerInGame && data.answer === data.correctAnswer) {
        playerInGame.score += 10;
    }
    
    // Mark as answered
    playerInGame.answered = true;
    
    // Check if all players answered
    const allAnswered = game.players.every(p => p.answered);
    if (allAnswered) {
        clearTimeout(game.questionTimeout);
        endQuestion(gameCode);
    }
}

function endQuestion(gameCode) {
    const game = games.get(gameCode);
    if (!game) return;
    
    // Send results to all players
    game.players.forEach(p => {
        if (p.ws.readyState === 1) {
            p.ws.send(JSON.stringify({
                type: "question_results",
                players: game.players,
                round: game.currentRound
            }));
        }
        p.answered = false;
    });
    
    game.currentRound++;
    
    // Check if game is over
    if (game.currentRound > game.settings.rounds) {
        endGame(gameCode);
    } else {
        // Send next question after delay
        setTimeout(() => {
            sendNewQuestion(gameCode);
        }, 3000);
    }
}

function endGame(gameCode) {
    const game = games.get(gameCode);
    if (!game) return;
    
    game.status = "finished";
    
    // Sort players by score
    const sortedPlayers = [...game.players].sort((a, b) => b.score - a.score);
    
    // Send final results
    game.players.forEach(p => {
        if (p.ws.readyState === 1) {
            p.ws.send(JSON.stringify({
                type: "game_over",
                players: sortedPlayers,
                winner: sortedPlayers[0]
            }));
        }
    });
    
    console.log(`Game ${gameCode} finished. Winner: ${sortedPlayers[0].name}`);
    
    // Clean up after 5 minutes
    setTimeout(() => {
        games.delete(gameCode);
    }, 300000);
}

function handlePlayerDisconnect(playerId) {
    const player = players.get(playerId);
    if (!player || !player.gameCode) return;
    
    const gameCode = player.gameCode;
    const game = games.get(gameCode);
    if (!game) return;
    
    // Remove player from game
    game.players = game.players.filter(p => p.id !== playerId);
    
    // Notify remaining players
    game.players.forEach(p => {
        if (p.ws.readyState === 1) {
            p.ws.send(JSON.stringify({
                type: "player_left",
                playerName: player.name,
                players: game.players,
                playerCount: game.players.length
            }));
        }
    });
    
    // If no players left, delete game
    if (game.players.length === 0) {
        games.delete(gameCode);
        console.log(`Game ${gameCode} deleted (no players)`);
    }
}

// Utility functions
function generateGameCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log("=========================================");
    console.log("🎮 VOCAB GAME SERVER STARTED!");
    console.log("=========================================");
    console.log(`📍 Local:  http://localhost:${PORT}`);
    console.log(`🌐 Network: http://YOUR_IP:${PORT}`);
    console.log("=========================================");
    console.log("\n📱 How to play with friends:");
    console.log("1. Find your IP: ipconfig | findstr IPv4");
    console.log("2. Share: http://YOUR_IP:3000");
    console.log("3. Create game & share code with friends");
    console.log("=========================================");
});