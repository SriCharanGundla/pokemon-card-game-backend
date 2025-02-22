const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

// Store active game rooms
const gameRooms = new Map();
// Store active players (by name, lowercased)
const activePlayers = new Set();

const checkNameExists = (name) => {
  return activePlayers.has(name.toLowerCase());
};

async function fetchRandomPokemon() {
  const id = Math.floor(Math.random() * 898) + 1;
  const response = await axios.get(`https://pokeapi.co/api/v2/pokemon/${id}`);
  const pokemon = response.data;
  return {
    id: pokemon.id,
    name: pokemon.name,
    sprite: pokemon.sprites.other["official-artwork"].front_default,
    hp: pokemon.stats[0].base_stat,
    stats: {
      attack: pokemon.stats[1].base_stat,
      defense: pokemon.stats[2].base_stat,
      speed: pokemon.stats[5].base_stat,
    },
  };
}

class GameRoom {
  constructor(settings) {
    this.players = new Map();
    this.currentRound = 1;
    this.currentPicker = null;
    this.settings = settings; // roundsToWin will be updated via updateSettings
    this.winners = [];
    this.creator = null;
    // For round-robin rotation
    this.pickerCycle = [];
    this.pickerIndex = 0;
  }

  addPlayer(playerId, playerName, isCreator = false) {
    const player = {
      name: playerName,
      score: 0,
      pokemon: null,
      isCreator,
    };
    this.players.set(playerId, player);
    activePlayers.add(playerName.toLowerCase());
    if (isCreator) {
      this.creator = playerId;
    }
    return player;
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (player) {
      activePlayers.delete(player.name.toLowerCase());
      this.players.delete(playerId);
    }
  }

  async startNewRound() {
    if (this.currentRound === 1) {
      this.pickerCycle = Array.from(this.players.keys());
      this.pickerIndex = Math.floor(Math.random() * this.pickerCycle.length);
      this.currentPicker = this.pickerCycle[this.pickerIndex];
    } else {
      this.pickerIndex = (this.pickerIndex + 1) % this.pickerCycle.length;
      this.currentPicker = this.pickerCycle[this.pickerIndex];
    }
    for (const [playerId, player] of this.players.entries()) {
      player.pokemon = await fetchRandomPokemon();
    }
    const state = {
      currentRound: this.currentRound, // use "currentRound" for consistency
      currentPicker: this.currentPicker,
      players: Array.from(this.players.entries()).map(([id, player]) => ({
        id,
        name: player.name,
        pokemon: player.pokemon,
        score: player.score,
        isPicker: id === this.currentPicker,
        isCreator: player.isCreator,
      })),
    };
    this.currentRound++;
    return state;
  }

  evaluateRound(selectedStat) {
    let highestValue = -1;
    let winners = [];
    for (const [playerId, player] of this.players.entries()) {
      const value =
        selectedStat === "hp"
          ? player.pokemon.hp
          : player.pokemon.stats[selectedStat];
      if (value > highestValue) {
        highestValue = value;
        winners = [playerId];
      } else if (value === highestValue) {
        winners.push(playerId);
      }
    }
    winners.forEach((winnerId) => {
      const player = this.players.get(winnerId);
      player.score++;
      if (player.score >= this.settings.roundsToWin) {
        this.winners.push(winnerId);
      }
    });
    return winners;
  }

  async startGame() {
    this.currentRound = 1;
    this.winners = [];
    this.players.forEach((player) => (player.score = 0));
    return this.startNewRound();
  }
}

io.on("connection", (socket) => {
  socket.on("addName", (name, callback) => {
    activePlayers.add(name.toLowerCase());
    callback(true);
  });

  socket.on("checkName", (name, callback) => {
    const exists = checkNameExists(name);
    callback(exists);
  });

  socket.on("updateSettings", ({ roomCode, settings }) => {
    const gameRoom = gameRooms.get(roomCode);
    if (!gameRoom) return;
    gameRoom.settings = { ...gameRoom.settings, ...settings };
  });

  socket.on("createRoom", ({ playerName, settings }) => {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const gameRoom = new GameRoom(settings);
    const player = gameRoom.addPlayer(socket.id, playerName, true);
    gameRooms.set(roomCode, gameRoom);
    socket.join(roomCode);
    socket.emit("roomCreated", {
      roomCode,
      players: [{ id: socket.id, name: playerName, isCreator: true, score: 0 }],
    });
  });

  socket.on("joinRoom", ({ roomCode, playerName }) => {
    const gameRoom = gameRooms.get(roomCode);
    if (!gameRoom) {
      socket.emit("error", "Room not found");
      return;
    }
    const player = gameRoom.addPlayer(socket.id, playerName);
    socket.join(roomCode);
    socket.emit("gameStateUpdate", {
      roomCode,
      players: Array.from(gameRoom.players.entries()).map(([id, p]) => ({
        id,
        name: p.name,
        isCreator: p.isCreator,
        score: p.score,
      })),
      phase: "in-room",
    });
    io.to(roomCode).emit("playerJoined", {
      players: Array.from(gameRoom.players.entries()).map(([id, p]) => ({
        id,
        name: p.name,
        isCreator: p.isCreator,
        score: p.score,
      })),
    });
  });

  socket.on("startGame", async ({ roomCode }) => {
    const gameRoom = gameRooms.get(roomCode);
    if (!gameRoom) return;
    const gameState = await gameRoom.startGame();
    io.to(roomCode).emit("roundStarted", gameState);
  });

  socket.on("selectStat", ({ roomCode, stat }) => {
    const gameRoom = gameRooms.get(roomCode);
    if (!gameRoom || gameRoom.currentPicker !== socket.id) return;
    const roundWinners = gameRoom.evaluateRound(stat);
    io.to(roomCode).emit("roundComplete", {
      winners: roundWinners,
      gameWinners: gameRoom.winners,
      stat,
      players: Array.from(gameRoom.players.entries()).map(([id, player]) => ({
        id,
        name: player.name,
        pokemon: player.pokemon,
        score: player.score,
        isPicker: id === gameRoom.currentPicker,
        isCreator: player.isCreator,
      })),
    });
    if (gameRoom.winners.length === 0) {
      setTimeout(async () => {
        const newState = await gameRoom.startNewRound();
        io.to(roomCode).emit("roundStarted", newState);
      }, 3000);
    }
  });

  socket.on("rematch", ({ roomCode }) => {
    const gameRoom = gameRooms.get(roomCode);
    if (!gameRoom) return;
    gameRoom.currentRound = 0;
    gameRoom.winners = [];
    gameRoom.players.forEach((player) => (player.score = 0));
    io.to(roomCode).emit("gameReset");
    setTimeout(async () => {
      const newState = await gameRoom.startNewRound();
      io.to(roomCode).emit("roundStarted", newState);
    }, 1000);
  });

  socket.on("leaveRoom", ({ roomCode }) => {
    const gameRoom = gameRooms.get(roomCode);
    if (!gameRoom) return;
    gameRoom.players.delete(socket.id);
    socket.leave(roomCode);
    if (gameRoom.players.size === 0) {
      gameRooms.delete(roomCode);
    } else {
      io.to(roomCode).emit("playerLeft", {
        playerId: socket.id,
        players: Array.from(gameRoom.players.entries()).map(([id, player]) => ({
          id,
          name: player.name,
          score: player.score,
        })),
      });
    }
  });

  socket.on("kickPlayer", ({ roomCode, playerId }) => {
    const gameRoom = gameRooms.get(roomCode);
    if (!gameRoom || gameRoom.creator !== socket.id) return;
    gameRoom.removePlayer(playerId);
    io.to(roomCode).emit("playerKicked", {
      kickedId: playerId,
      players: Array.from(gameRoom.players.entries()).map(([id, player]) => ({
        id,
        name: player.name,
        score: player.score,
      })),
    });
    io.to(playerId).emit("youWereKicked");
  });

  socket.on("disconnect", () => {
    for (const room of gameRooms.values()) {
      const player = room.players.get(socket.id);
      if (player) {
        activePlayers.delete(player.name.toLowerCase());
        room.removePlayer(socket.id);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
