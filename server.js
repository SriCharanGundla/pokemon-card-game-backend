require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Store active game rooms
const gameRooms = new Map();

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
    type: pokemon.types[0].type.name,
  };
}

class GameRoom {
  constructor(settings) {
    this.players = new Map();
    this.currentRound = 1;
    this.currentPicker = null;
    this.settings = {
      roundsToWin: settings.roundsToWin || 3,
      maxWinners: this.validateMaxWinners(settings.maxWinners || 1),
    };
    this.winners = [];
    this.creator = null;
    this.pickerCycle = [];
    this.pickerIndex = 0;
    this.inTieBreaker = false;
    this.tieBreakPlayers = [];
    this.lastSelectedStat = null;
    this.playerNames = new Set();
  }

  hasPlayerName(name) {
    return this.playerNames.has(name.toLowerCase());
  }

  addPlayer(playerId, playerName, isCreator = false) {
    const player = {
      name: playerName,
      score: 0,
      pokemon: null,
      isCreator,
    };
    this.players.set(playerId, player);
    this.playerNames.add(playerName.toLowerCase()); // Add to this room's names
    if (isCreator) {
      this.creator = playerId;
    }
    return player;
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (player) {
      this.playerNames.delete(player.name.toLowerCase());
      this.players.delete(playerId);
    }
  }

  clearPlayerName(playerId) {
    const player = this.players.get(playerId);
    if (player) {
      this.playerNames.delete(player.name.toLowerCase());
    }
  }

  clearAllPlayerNames() {
    this.playerNames.clear();
  }

  validateMaxWinners(maxWinners) {
    const playerCount = this.players.size;
    // For 2 players, we should allow 1 winner
    // For 3+ players, maximum winners cannot exceed playerCount - 1
    if (playerCount <= 2) {
      return 1;
    }
    return Math.min(maxWinners, Math.min(playerCount - 1, 3));
  }

  updateSettings(settings) {
    if (settings.maxWinners !== undefined) {
      settings.maxWinners = this.validateMaxWinners(settings.maxWinners);
    }
    this.settings = { ...this.settings, ...settings };
  }

  getActivePlayers() {
    return Array.from(this.players.keys()).filter(
      (id) => !this.winners.includes(id)
    );
  }

  getNextPicker() {
    const activePlayers = this.getActivePlayers();
    if (activePlayers.length === 0) return null;

    // If current picker is a winner or doesn't exist, find next valid picker
    if (!this.currentPicker || this.winners.includes(this.currentPicker)) {
      return activePlayers[0];
    }

    // Find current picker's index in active players
    const currentIndex = activePlayers.indexOf(this.currentPicker);
    if (currentIndex === -1) return activePlayers[0];

    // Get next picker, wrapping around to start if needed
    return activePlayers[(currentIndex + 1) % activePlayers.length];
  }

  // Add to the GameRoom class in your server file
  transferCreator(oldCreatorId, newCreatorId) {
    const oldCreator = this.players.get(oldCreatorId);
    const newCreator = this.players.get(newCreatorId);

    if (!oldCreator || !newCreator || oldCreatorId !== this.creator) {
      return false; // Cannot transfer if either player doesn't exist or if requester isn't creator
    }

    // Update creator status
    oldCreator.isCreator = false;
    newCreator.isCreator = true;
    this.creator = newCreatorId;

    return true;
  }

  assignNewCreator() {
    // If there's no creator or the creator has left, assign a new one
    if (
      this.players.size > 0 &&
      (!this.creator || !this.players.has(this.creator))
    ) {
      const nextCreatorId = Array.from(this.players.keys())[0];
      const nextCreator = this.players.get(nextCreatorId);
      nextCreator.isCreator = true;
      this.creator = nextCreatorId;
      return nextCreatorId;
    }
    return null;
  }

  async startNewRound() {
    if (this.inTieBreaker) {
      // In tie breaker, regenerate Pokemon only for tie break players
      for (const playerId of this.tieBreakPlayers) {
        const player = this.players.get(playerId);
        if (player) {
          player.pokemon = await fetchRandomPokemon();
        }
      }
    } else {
      // Regular round - update picker and generate Pokemon for active players
      this.currentPicker = this.getNextPicker();

      // Generate Pokemon only for non-winner players
      const activePlayers = this.getActivePlayers();
      for (const playerId of activePlayers) {
        const player = this.players.get(playerId);
        player.pokemon = await fetchRandomPokemon();
      }
    }

    const state = {
      currentRound: this.currentRound,
      currentPicker: this.currentPicker,
      inTieBreaker: this.inTieBreaker,
      tieBreakPlayers: this.tieBreakPlayers,
      players: Array.from(this.players.entries()).map(([id, player]) => ({
        id,
        name: player.name,
        pokemon: player.pokemon,
        score: player.score,
        isPicker: id === this.currentPicker,
        isCreator: player.isCreator,
        isWinner: this.winners.includes(id),
      })),
      winners: this.winners, // Add winners to state
      gameEnded: this.winners.length >= this.settings.maxWinners, // Add gameEnded
    };

    if (!this.inTieBreaker) {
      this.currentRound++;
    }
    return state;
  }

  evaluateRound(selectedStat) {
    this.lastSelectedStat = selectedStat;
    let highestValue = -1;
    let roundWinners = [];

    // Determine which players to evaluate
    const playersToEvaluate = this.inTieBreaker
      ? this.tieBreakPlayers
      : this.getActivePlayers();

    // Find highest value and its holders
    for (const playerId of playersToEvaluate) {
      const player = this.players.get(playerId);
      const value =
        selectedStat === "hp"
          ? player.pokemon.hp
          : player.pokemon.stats[selectedStat];
      if (value > highestValue) {
        highestValue = value;
        roundWinners = [playerId];
      } else if (value === highestValue) {
        roundWinners.push(playerId);
      }
    }

    // Update winner logic
    if (!this.inTieBreaker) {
      const winner = this.players.get(roundWinners[0]);
      if (winner) {
        winner.score++;
        // Only add to winners if they've reached the required score
        if (winner.score >= this.settings.roundsToWin) {
          if (!this.winners.includes(roundWinners[0])) {
            this.winners.push(roundWinners[0]);
          }
        }
      }
    }

    // Check if game should end - now properly considers required wins
    const gameEnded = this.winners.length >= this.settings.maxWinners;

    return {
      roundWinners,
      gameWinners: this.winners,
      players: Array.from(this.players.entries()).map(([id, player]) => ({
        id,
        name: player.name,
        pokemon: player.pokemon,
        score: player.score,
        isPicker: id === this.currentPicker,
        isCreator: player.isCreator,
      })),
      winners: this.winners,
      gameEnded,
      stat: selectedStat,
    };
  }

  async startGame() {
    this.currentRound = 1;
    this.winners = [];
    this.inTieBreaker = false;
    this.tieBreakPlayers = [];
    this.lastSelectedStat = null;
    this.players.forEach((player) => {
      player.score = 0;
      player.pokemon = null;
    });
    return this.startNewRound();
  }
}

io.on("connection", (socket) => {
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

  // Update the joinRoom event handler
  socket.on("joinRoom", ({ roomCode, playerName }) => {
    const gameRoom = gameRooms.get(roomCode);
    if (!gameRoom) {
      socket.emit("error", "Room not found");
      return;
    }

    // Check for name duplicates within this room
    let existingPlayerId = null;
    let isNameDuplicate = false;

    for (const [id, player] of gameRoom.players.entries()) {
      if (player.name.toLowerCase() === playerName.toLowerCase()) {
        existingPlayerId = id;
        isNameDuplicate = true;
        break;
      }
    }

    // Case 1: Name exists in the room
    if (isNameDuplicate) {
      // CRITICAL FIX: We need a reliable way to determine if this is actually a reconnection
      // In a real reconnection scenario, the previous socket for this player would be disconnected
      // Check if the existing socket is still connected by attempting to get its handshake
      const io_sockets = io.sockets.sockets;
      const existingSocketStillConnected = io_sockets.has(existingPlayerId);

      // If the existing socket is still connected, this is a duplicate name attempt from a different client
      if (existingSocketStillConnected) {
        socket.emit(
          "error",
          "Name already exists in this room. Please choose a different name."
        );
        return;
      } else {
        // This is a genuine reconnection - the original socket is disconnected
        const player = gameRoom.players.get(existingPlayerId);

        // Transfer player data to new socket ID
        gameRoom.clearPlayerName(existingPlayerId);
        gameRoom.removePlayer(existingPlayerId);

        // Preserve player attributes, especially isCreator status
        gameRoom.addPlayer(socket.id, playerName, player.isCreator);

        // Update creator reference if needed
        if (player.isCreator) {
          gameRoom.creator = socket.id;
        }

        // Preserve score and pokemon if we're in a game
        const newPlayer = gameRoom.players.get(socket.id);
        newPlayer.score = player.score;
        newPlayer.pokemon = player.pokemon;

        socket.join(roomCode);

        // Notify everyone about the reconnection
        io.to(roomCode).emit("playerReconnected", {
          oldId: existingPlayerId,
          newId: socket.id,
          players: Array.from(gameRoom.players.entries()).map(([id, p]) => ({
            id,
            name: p.name,
            isCreator: p.isCreator,
            score: p.score,
          })),
        });

        // Send current game state to reconnected player
        const gamePhase = gameRoom.currentRound > 1 ? "playing" : "in-room";
        socket.emit("gameStateUpdate", {
          roomCode,
          players: Array.from(gameRoom.players.entries()).map(([id, p]) => ({
            id,
            name: p.name,
            isCreator: p.isCreator,
            score: p.score,
            pokemon: p.pokemon,
          })),
          currentRound: gameRoom.currentRound,
          currentPicker: gameRoom.currentPicker,
          winners: gameRoom.winners,
          phase: gamePhase,
        });
      }
    } else {
      // Case 2: Normal join process for new player with unique name
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
    }
  });

  socket.on("transferCreator", ({ roomCode, newCreatorId }) => {
    const gameRoom = gameRooms.get(roomCode);
    if (!gameRoom) return;

    // Try to transfer creator status
    const success = gameRoom.transferCreator(socket.id, newCreatorId);
    if (success) {
      io.to(roomCode).emit("creatorTransferred", {
        previousCreatorId: socket.id,
        newCreatorId,
        players: Array.from(gameRoom.players.entries()).map(([id, player]) => ({
          id,
          name: player.name,
          score: player.score,
          isCreator: player.isCreator,
        })),
      });
    }
  });

  socket.on("startGame", async ({ roomCode }) => {
    const gameRoom = gameRooms.get(roomCode);
    if (!gameRoom) return;
    const gameState = await gameRoom.startGame();
    io.to(roomCode).emit("roundStarted", gameState);
  });

  // In the socket.on("selectStat") handler, update to use new state:
  socket.on("selectStat", ({ roomCode, stat }) => {
    const gameRoom = gameRooms.get(roomCode);
    if (!gameRoom || gameRoom.currentPicker !== socket.id) return;

    const gameState = gameRoom.evaluateRound(stat);

    // If game has ended, clear all player names
    if (gameState.gameEnded) {
      gameRoom.clearAllPlayerNames();
    }

    io.to(roomCode).emit("roundComplete", {
      winners: gameState.roundWinners,
      gameWinners: gameState.gameWinners,
      stat,
      players: gameState.players,
      gameEnded: gameState.gameEnded,
    });

    if (!gameState.gameEnded) {
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

    // Get the leaving player's data before removing
    const leavingPlayer = gameRoom.players.get(socket.id);
    const wasCreator = leavingPlayer?.isCreator;

    // Clear the leaving player's name
    gameRoom.clearPlayerName(socket.id);
    gameRoom.removePlayer(socket.id);

    socket.leave(roomCode);

    if (gameRoom.players.size === 0) {
      // If room is empty, delete the room
      gameRooms.delete(roomCode);
    } else {
      // If the creator left, assign a new one
      let newCreatorId = null;
      if (wasCreator) {
        newCreatorId = gameRoom.assignNewCreator();
      }

      io.to(roomCode).emit("playerLeft", {
        playerId: socket.id,
        leftPlayer: leavingPlayer ? { name: leavingPlayer.name } : null,
        newCreatorId,
        players: Array.from(gameRoom.players.entries()).map(([id, player]) => ({
          id,
          name: player.name,
          score: player.score,
          isCreator: player.isCreator,
        })),
      });
    }
  });

  socket.on("kickPlayer", ({ roomCode, playerId }) => {
    const gameRoom = gameRooms.get(roomCode);
    if (!gameRoom || gameRoom.creator !== socket.id) return;

    gameRoom.clearPlayerName(playerId);
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
    // Check all game rooms for the disconnected player
    for (const [roomCode, room] of gameRooms.entries()) {
      const player = room.players.get(socket.id);
      if (player) {
        const wasCreator = player.isCreator;
        room.clearPlayerName(socket.id);
        room.removePlayer(socket.id);

        // If room is empty, delete it
        if (room.players.size === 0) {
          gameRooms.delete(roomCode);
        } else {
          // If the creator left, assign a new one
          let newCreatorId = null;
          if (wasCreator) {
            newCreatorId = room.assignNewCreator();
          }

          // Notify remaining players
          io.to(roomCode).emit("playerLeft", {
            playerId: socket.id,
            leftPlayer: player ? { name: player.name } : null,
            newCreatorId,
            players: Array.from(room.players.entries()).map(([id, p]) => ({
              id,
              name: p.name,
              score: p.score,
              isCreator: p.isCreator,
            })),
          });
        }
        break; // Player found and handled, exit the loop
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
