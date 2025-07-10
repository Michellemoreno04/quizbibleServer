const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});


// Middleware
app.use(cors());
app.use(express.json());

// Almacenamiento de salas en memoria
const gameRooms = new Map();

// Almacenamiento de timeouts para eliminar salas
const roomTimeouts = new Map();

// Ruta principal
app.get('/', (req, res) => {
  res.json({ message: 'Servidor funcionandoooo0' });
});

// Ruta de prueba
app.get('/test', (req, res) => {
  res.json({ 
    success: true, 
    data: 'Todo bien' 
  });
});

// Ruta para verificar si una sala existe
app.get('/room/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = gameRooms.get(roomId);
  
 // console.log(`Verificando sala: ${roomId}`);
 // console.log(`Salas existentes:`, Array.from(gameRooms.keys()));
  
  if (room) {
    res.json({ 
      exists: true, 
      room: {
        id: roomId,
        players: room.players,
        playersData: room.playersData,
        status: room.status,
        creator: room.creator,
        gameSettings: room.gameSettings
      }
    });
  } else {
    res.json({ exists: false });
  }
});

// Ruta para obtener todas las salas (para debugging)
app.get('/rooms', (req, res) => {
  const rooms = Array.from(gameRooms.entries()).map(([id, room]) => ({
    id,
    players: room.players,
    status: room.status,
    creator: room.creator
  }));
  res.json({ rooms });
});

// Socket.IO connection handling
io.on('connection', (socket) => {

  // Crear nueva sala de juego
  socket.on('createRoom', (data) => {
    const { userId, userName, userEmail, questions } = data;
        
    // Validar que se recibieron las preguntas
    if (!questions || questions.length === 0) {
      console.log(`❌ No se recibieron preguntas para la sala`);
      socket.emit('roomCreationError', { message: 'No se recibieron preguntas para la sala' });
      return;
    }
    
    
    // Generar código de sala
    const generateRoomCode = () => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let result = '';
      for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    };

    let roomId = generateRoomCode();
    let attempts = 0;
    
    // Verificar que el código no exista para evitar colisiones
    while (gameRooms.has(roomId) && attempts < 10) {
      roomId = generateRoomCode();
      attempts++;
    }

    if (attempts >= 10) {
      socket.emit('roomCreationError', { message: 'No se pudo generar un código único' });
      return;
    }

    // Crear la sala con las preguntas del cliente
    const roomData = {
      id: roomId,
      creator: {
        uid: userId,
        email: userEmail,
        name: userName
      },
      players: [userId],
      playersData: {
        [userId]: {
          id: userId,
          name: userName,
          email: userEmail,
          socketId: socket.id,
          ready: false,
          score: 0,
          connected: true
        }
      },
      status: 'waiting',
      createdAt: new Date().toISOString(),
      maxPlayers: 2,
      gameSettings: {
        questionsCount: questions.length,
        timePerQuestion: 30,
      },
      currentQuestion: 0,
      gameStarted: false,
      questions: questions, // Usar las preguntas del cliente
      questionAnswers: {},
      scores: {}
    };

    gameRooms.set(roomId, roomData); // Guardar la sala en el mapa de salas
    
    // Unirse a la sala
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userId = userId;
    
    console.log(`🎮 Sala creada exitosamente: ${roomId}`);    
    // Notificar al creador
    socket.emit('roomCreated', {
      roomId,
      room: roomData
    });
  });

  // Unirse a una sala de juego
  socket.on('joinRoom', (data) => {
    const { roomId, userId, userName, userEmail } = data;
        
    const room = gameRooms.get(roomId);
    
    if (!room) {
      socket.emit('joinRoomError', { message: 'La sala no existe' });
      return;
    }


    // Verificar si es una reconexión
    const isReconnection = room.players.includes(userId);
    
    if (isReconnection) {
      console.log(`Usuario ${userId} se está reconectando a la sala ${roomId}`);
      
      // Cancelar timeout de eliminación si existe
      if (roomTimeouts.has(roomId)) {
        clearTimeout(roomTimeouts.get(roomId));
        roomTimeouts.delete(roomId);
        console.log(`Timeout de eliminación cancelado para sala ${roomId}`);
      }
      
      // Actualizar datos del jugador para reconexión
      room.playersData[userId] = {
        ...room.playersData[userId],
        socketId: socket.id,
        connected: true,
        disconnectedAt: null
      };
      
      // Asegurarse de que el socket esté en la sala
      socket.join(roomId);
      socket.roomId = roomId;
      socket.userId = userId;
      
      console.log(`Usuario ${userName} (${userId}) se reconectó a la sala ${roomId}`);
      
      // Notificar reconexión
      io.to(roomId).emit('playerReconnected', {
        roomId,
        reconnectedPlayerId: userId,
        players: room.players,
        playersData: room.playersData,
        creator: room.creator,
        gameSettings: room.gameSettings
      });
      
      // Si la sala ya está jugando, enviar estado del juego
      if (room.status === 'playing') {
        
        // Preparar preguntas para enviar al cliente (sin respuestas correctas)
        const questionsForClient = room.questions.map(q => ({
          questionId: q.questionId,
          question: q.question,
          answers: q.answers,
          bibleReference: q.bibleReference,
          index: q.index
          // NO enviamos correctAnswer al cliente 
        }));

        // Enviar estado actual del juego solo al jugador reconectado
        socket.emit('gameInProgress', {
          roomId,
          players: room.players,
          playersData: room.playersData,
          creator: room.creator,
          gameSettings: room.gameSettings,
          scores: room.scores,
          questions: questionsForClient,
          currentQuestion: room.currentQuestion
        });
      }
      
      return;
    }

    // Validaciones para nuevos jugadores
    if (room.status !== 'waiting') {
      socket.emit('joinRoomError', { message: 'Esta sala ya no está disponible' });
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      socket.emit('joinRoomError', { message: 'La sala está llena' });
      return;
    }

    // Unirse a la sala de Socket.IO
    socket.join(roomId);
    
    // Agregar jugador a la sala
    room.players.push(userId);
    room.playersData[userId] = {
      id: userId,
      name: userName,
      email: userEmail,
      socketId: socket.id,
      ready: false,
      score: 0,
      connected: true
    };
    
    // Guardar referencia de la sala en el socket
    socket.roomId = roomId;
    socket.userId = userId;
    
    
    // Notificar a todos en la sala
    io.to(roomId).emit('playerJoined', {
      roomId,
      players: room.players,
      playersData: room.playersData,
      creator: room.creator,
      gameSettings: room.gameSettings
    });
  });

  // Marcar usuario como listo
  socket.on('playerReady', (data) => {
    const { roomId, userId } = data;
    const room = gameRooms.get(roomId);
    
    if (room && room.playersData[userId]) {
      room.playersData[userId].ready = true;
            
      // Verificar si todos están listos
      const allReady = room.players.every(playerId => 
        room.playersData[playerId]?.ready
      );
      
      
      if (allReady && room.players.length === 2) {
        room.status = 'playing';
        room.players.forEach(playerId => {
          const player = room.playersData[playerId];
        });
                
        // Preparar preguntas para enviar al cliente (sin respuestas correctas)
        const questionsForClient = room.questions.map(q => ({
          questionId: q.questionId,
          question: q.question,
          answers: q.answers,
          bibleReference: q.bibleReference,
          index: q.index
          // NO enviamos correctAnswer al cliente
        }));


        // Notificar a todos que el juego puede comenzar
        io.to(roomId).emit('gameReady', {
          roomId,
          players: room.players,
          playersData: room.playersData,
          creator: room.creator,
          gameSettings: room.gameSettings,
          scores: room.scores,
          questions: questionsForClient
        });
      } else {
       // console.log(`⏳ No todos están listos aún en sala ${roomId}`);
        room.players.forEach(playerId => {
          const player = room.playersData[playerId];
          console.log(`   - ${player.name}: ${player.ready ? 'Listo' : 'No listo'}`);
        });
        
        // Notificar actualización del estado
        io.to(roomId).emit('playerStatusUpdated', {
          roomId,
          players: room.players,
          playersData: room.playersData,
          creator: room.creator,
          gameSettings: room.gameSettings
        });
      }
    } else {
      console.log(`❌ No se pudo marcar como listo: sala o usuario no encontrado`);
    }
  });

  // Solicitar estado actual de la sala
  socket.on('requestRoomState', (data) => {
    const { roomId, userId } = data;
    const room = gameRooms.get(roomId);
    
    
    if (!room) {
      socket.emit('roomStateError', { message: 'La sala no existe' });
      return;
    }

    
    if (room.status === 'waiting') {
      // Si la sala está esperando, enviar estado de espera
      socket.emit('roomWaiting', {
        roomId,
        players: room.players,
        playersData: room.playersData,
        creator: room.creator,
        gameSettings: room.gameSettings
      });
    } else if (room.status === 'playing') {
      
      // Preparar preguntas para enviar al cliente (sin respuestas correctas)
      const questionsForClient = room.questions.map(q => ({
        questionId: q.questionId,
        question: q.question,
        answers: q.answers,
        bibleReference: q.bibleReference,
        index: q.index
        // NO enviamos correctAnswer al cliente
      }));

      socket.emit('gameInProgress', {
        roomId,
        players: room.players,
        playersData: room.playersData,
        creator: room.creator,
        gameSettings: room.gameSettings,
        scores: room.scores,
        questions: questionsForClient,
        currentQuestion: room.currentQuestion
      });
    } else {
      // Sala terminada o en otro estado
      socket.emit('roomStateInfo', {
        roomId,
        status: room.status,
        message: `La sala está en estado: ${room.status}`
      });
    }
  });



  // Enviar respuesta del jugador
  socket.on('submitAnswer', (data) => {
    const { roomId, userId, questionIndex, answer } = data;
    const room = gameRooms.get(roomId);
    console.log(`Respuesta recibida: ${answer}`);
    if (room) {
      // Obtener la pregunta actual desde la sala
      const currentQuestion = room.questions[questionIndex];
      if (!currentQuestion) {
        console.error(`Pregunta no encontrada para índice ${questionIndex} en sala ${roomId}`);
        return;
      }
      
      // Verificar respuesta usando las preguntas de la sala
      const isCorrect = answer === currentQuestion.correctAnswer;
      const points = isCorrect ? 10 : 0;
      
      // Inicializar respuestas de la pregunta si no existe
      if (!room.questionAnswers[questionIndex]) {
        room.questionAnswers[questionIndex] = {};
      }
      
      // Guardar respuesta del jugador
      room.questionAnswers[questionIndex][userId] = {
        answer,
        isCorrect,
        points,
        timestamp: new Date().toISOString()
      };
      console.log(`se debio guardar la respuesta del jugador ${userId} en ${room.questionAnswers[questionIndex]}`);
      
      // Actualizar puntuación
      if (!room.scores[userId]) {
        room.scores[userId] = 0;
      }
      room.scores[userId] += points;
      
      // Verificar si ambos jugadores respondieron **************
      const answeredPlayers = Object.keys(room.questionAnswers[questionIndex]);
      const bothAnswered = room.players.length === 2 && answeredPlayers.length === 2;
      
      if (bothAnswered) {
        // enviar resultados de la preguntas  
       try {
          io.to(roomId).emit('questionResults', { 
            roomId,
            questionIndex,
            answers: room.questionAnswers[questionIndex],
            scores: room.scores,
            correctAnswer: currentQuestion.correctAnswer,
          });
          console.log(`se debio enviar los resultados de la pregunta ${questionIndex} al cliente ${roomId}`);
       } catch (error) {
        console.log(`error al enviar los resultados de la pregunta ${questionIndex} a ${roomId}: ${error}`);
       }
        // Después de 2 segundos, pasar a la siguiente pregunta
        setTimeout(() => {
          room.currentQuestion++;
          
          if (room.currentQuestion >= room.questions.length) { // *************
            // Juego terminado
            room.status = 'finished';
            io.to(roomId).emit('gameFinished', {
              roomId,
              finalScores: room.scores,
              playersData: room.playersData
            });
            console.log('juego terminado0000000000000 en el servidor')
          } else {
            // Siguiente pregunta
            io.to(roomId).emit('nextQuestion', {
              roomId,
              currentQuestion: room.currentQuestion,
              scores: room.scores
            });
          }
        }, 2000); 
      } else {
        // Notificar que un jugador respondió
        io.to(roomId).emit('playerAnswered', {
          roomId,
          questionIndex,
          answeredPlayers,
          waitingFor: room.players.filter(p => !answeredPlayers.includes(p))
        });
      }
    } 
  });

  // Desconectar usuario
  socket.on('disconnect', () => {
    console.log(`Usuario desconectado: ${socket.id}`);
    
    if (socket.roomId && socket.userId) {
      const room = gameRooms.get(socket.roomId);
      if (room) {
        // Marcar jugador como desconectado en lugar de eliminarlo inmediatamente
        if (room.playersData[socket.userId]) {
          room.playersData[socket.userId].connected = false;
          room.playersData[socket.userId].disconnectedAt = new Date().toISOString();
          
          // Verificar si todos los jugadores están desconectados
          const connectedPlayers = room.players.filter(playerId => 
            room.playersData[playerId]?.connected !== false
          );
          
          if (connectedPlayers.length === 0) {
            // Solo programar eliminación si el juego no está en progreso
            if (room.status === 'waiting' || room.status === 'finished') {
              if (roomTimeouts.has(socket.roomId)) {
                clearTimeout(roomTimeouts.get(socket.roomId));
              }
              
              const timeout = setTimeout(() => {
                const roomToDelete = gameRooms.get(socket.roomId);
                if (roomToDelete) {
                  const stillConnected = roomToDelete.players.filter(playerId => 
                    roomToDelete.playersData[playerId]?.connected !== false
                  );
                  
                  if (stillConnected.length === 0) {
                    gameRooms.delete(socket.roomId);
                    roomTimeouts.delete(socket.roomId);
                    console.log(`Sala ${socket.roomId} eliminada después del período de gracia`);
                  }
                }
              }, 300000); // 5 minutos de gracia
              
              roomTimeouts.set(socket.roomId, timeout);
              console.log(`Programada eliminación de sala ${socket.roomId} en 5 minutos (solo si no está jugando)`);
            } else {
              console.log(`Sala ${socket.roomId} está en juego, no se programará eliminación automática`);
            }
          } else {
            // Notificar a los demás jugadores que alguien se desconectó
            io.to(socket.roomId).emit('playerDisconnected', {
              roomId: socket.roomId,
              disconnectedPlayerId: socket.userId,
              players: room.players,
              playersData: room.playersData,
              creator: room.creator,
              gameSettings: room.gameSettings
            });
          }
        }
      }
    }
  });

  // Salir de sala manualmente
  socket.on('leaveRoom', (data) => {
    const { roomId, userId } = data;
    const room = gameRooms.get(roomId);
    
    if (room) {
      const playerIndex = room.players.indexOf(userId);
      if (playerIndex > -1) {
        room.players.splice(playerIndex, 1);
        delete room.playersData[userId];
                
        // Si no quedan jugadores, eliminar la sala inmediatamente
        if (room.players.length === 0) {
          // Cancelar timeout si existe
          if (roomTimeouts.has(roomId)) {
            clearTimeout(roomTimeouts.get(roomId));
            roomTimeouts.delete(roomId);
          }
          
          gameRooms.delete(roomId);
          console.log(`Sala ${roomId} eliminada`);
        } else {
          // Notificar a los demás jugadores
          io.to(roomId).emit('playerLeft', {
            roomId,
            players: room.players,
            playersData: room.playersData,
            creator: room.creator,
            gameSettings: room.gameSettings
          });
        }
      }
    }
    
    socket.leave(roomId);
  });
});

// Iniciar servidor
server.listen(process.env.PORT || 3000, () => {
  console.log(`Servidor corriendo en puerto ${process.env.PORT}`);
  console.log(`📡 Socket.IO habilitado`);
});
