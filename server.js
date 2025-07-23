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
  },
  // optimizaciones criticas:
  pingTimeout: 45000, // Reducir de 60s a 45s
  pingInterval: 20000, // Reducir de 25s a 20s
  transports: ['websocket'], // solo websocket no polling 
  allowEIO3: false, // desavilitar versiones antiguas
  maxHttpBufferSize: 1e6, // 1MB
  // limitar conexciones por IP
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    if (!origin || origin === 'null') {
      return callback(null, true);
    }
    callback(null, true);
  }

});

// middleware para compresion
const compression = require('compression');
app.use(compression());
// rate limiting
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 200, // Aumentar de 100 a 200 requests por IP
  message: 'Demasiadas requests desde esta IP'
});
app.use(limiter);

// configuracion de memoria
const v8 = require('v8');
const totalHeapSize = v8.getHeapStatistics().total_available_size;
const totalHeapSizeInGB = (totalHeapSize / 1024 / 1024 / 1024).toFixed(2);
console.log(`Memoria total disponible: ${totalHeapSizeInGB} GB`);
// monitoreo de memoria
setInterval(() => {
  const used = process.memoryUsage();
  console.log(`Memoria usada: ${Math.round(used.heapUsed / 1024 / 1024)} MB`);
}, 300000); // Cada 5 minutos 

// timite de conexiones por IP
const connectionCount = new Map();
const MAX_CONNECTIONS_PER_IP = 75; // Aumentar de 30 a 75

// middleware para limitar conexiones por IP
io.use((socket, next) => {
  const clientIp = socket.handshake.address;
  const currentCount = connectionCount.get(clientIp) || 0;

  if (currentCount >= MAX_CONNECTIONS_PER_IP) {
    return next(new Error('Demasiadas conexiones desde esta IP'));
  }

  connectionCount.set(clientIp, currentCount + 1);
  socket.on('disconnect', () => {
    const newCount = connectionCount.get(clientIp) - 1;
    if (newCount <= 0) {
      connectionCount.delete(clientIp);
    } else {
      connectionCount.set(clientIp, newCount);
    }
  });

  next();
});

// Configurar puerto para Heroku
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Almacenamiento de salas en memoria
const gameRooms = new Map();

// Almacenamiento de timeouts para eliminar salas
const roomTimeouts = new Map();

// Función para limpiar salas automáticamente
const cleanupInactiveRooms = () => {
  const now = new Date();
  const inactiveThreshold = 10 * 60 * 1000; // 10 minutos de inactividad

  let cleanedCount = 0;

  for (const [roomId, room] of gameRooms.entries()) {
    const roomAge = now - new Date(room.createdAt).getTime();
    //limpiar sala 
    if (roomAge > inactiveThreshold ||
      (room.status === 'finished' && roomAge > 5 * 60 * 1000) || //5 mnt para sala terminada
      (room.status === 'waiting' && roomAge > 10 * 60 * 1000)) {  // 10 mnt para sala en juego

      //cancelar timeout si existe
      if (roomTimeouts.has(roomId)) {
        clearTimeout(roomTimeouts.get(roomId));
        roomTimeouts.delete(roomId);
      }

      gameRooms.delete(roomId);
      cleanedCount++;
      console.log(`🧹 Limpiando sala inactiva: ${roomId} (edad: ${Math.round(roomAge / 60000)} minutos)`);

    }
  }

  if (cleanedCount > 0) {
    console.log(`🧹 Limpiadas ${cleanedCount} salas inactivas`);
  }
};

// Ejecutar limpieza automática cada 10 minutos
setInterval(cleanupInactiveRooms, 10 * 60 * 1000);

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
    creator: room.creator,
    createdAt: room.createdAt,
    age: Math.round((new Date() - new Date(room.createdAt)) / 60000) // edad en minutos
  }));
  res.json({
    rooms,
    totalRooms: rooms.length,
    activeRooms: rooms.filter(r => r.status === 'playing').length,
    waitingRooms: rooms.filter(r => r.status === 'waiting').length,
    finishedRooms: rooms.filter(r => r.status === 'finished').length
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {

  // Crear nueva sala de juego
  socket.on('createRoom', (data) => {
    const { userId, userName, userEmail, userPhoto } = data;

    // Generar código de sala
    const generateRoomCode = () => {
      const chars = '0123456789';
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

    // Crear la sala sin preguntas inicialmente
    const roomData = {
      id: roomId,
      creator: {
        uid: userId,
        name: userName
      },
      players: [userId],
      playersData: {
        [userId]: {
          id: userId,
          name: userName,
          socketId: null, // se actualisara cuando se conecte
          ready: false,
          score: 0,
          connected: true,
          photo: userPhoto
        }
      },
      status: 'waiting',
      createdAt: new Date(),
      maxPlayers: 2,
      gameSettings: {
        questionsCount: 10, // Configuración por defecto
        timePerQuestion: 18,
      },
      currentQuestion: 0,
      gameStarted: false,
      questions: [], // Las preguntas se obtendrán cuando ambos estén listos
      questionAnswers: {},
      scores: {},
      pendingQuestions: {}, // Para almacenar preguntas de cada jugador
      correctAnswers: {} // Nuevo objeto para rastrear respuestas correctas por jugador
    };

    gameRooms.set(roomId, roomData);

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
    const { roomId, userId, userName, userEmail, userPhoto } = data;

    const room = gameRooms.get(roomId);

    if (!room) {
       socket.emit('joinRoomError', { message: 'La sala no existe ' });
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
      connected: true,
      photo: userPhoto
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
    const { roomId, userId, questions, questionsId } = data;
    const room = gameRooms.get(roomId);

    if (room && room.playersData[userId]) {
      room.playersData[userId].ready = true;

      // Almacenar las preguntas del jugador si las proporciona
      if (questions && questions.length > 0) {
        room.pendingQuestions[userId] = questions;
        console.log(`📝 Preguntas recibidas de ${room.playersData[userId].name}: ${questions.length} preguntas`);
      }

      // Almacenar los IDs de las preguntas del jugador
      if (questionsId && questionsId.length > 0) {
        room.playersData[userId].userQuestionIds = questionsId;
        console.log(`📝 IDs de preguntas recibidos de ${room.playersData[userId].name}: ${questionsId.length} IDs`);
      }

      // Verificar si todos están listos
      const allReady = room.players.every(playerId =>
        room.playersData[playerId]?.ready
      );

      if (allReady && room.players.length === 2) {
        // Si la sala está en estado 'finished', hacer reset antes de iniciar
        if (room.status === 'finished') {
          console.log(`🔄 Sala ${roomId}: Iniciando revancha`);

          // Preservar los scores finales antes de resetear
          const finalScores = { ...room.scores };
          const playersData = { ...room.playersData };
          const questionsCount = room.questions.length;

          // Resetear el estado del juego
          room.status = 'waiting';
          room.questionAnswers = {};
          room.scores = {};
          room.currentQuestion = 0;
          room.questions = [];

          // LIMPIAR LAS PREGUNTAS PENDIENTES PARA FORZAR NUEVAS PREGUNTAS
          room.pendingQuestions = {};
          room.correctAnswers = {}; // Limpiar respuestas correctas

          // Resetear el estado "ready" de todos los jugadores
          Object.keys(room.playersData).forEach(playerId => {
            if (room.playersData[playerId]) {
              room.playersData[playerId].ready = false;
              // También limpiar los userQuestionIds para forzar nuevas preguntas
              room.playersData[playerId].userQuestionIds = [];
            }
          });

          // Notificar a todos los jugadores que el juego se reinició
          io.to(roomId).emit('gameStateReset', {

            roomId,
            message: 'Juego reiniciado para revancha',
            players: room.players,
            playersData: playersData,
            creator: room.creator,
            gameSettings: room.gameSettings,
            questionsCount: questionsCount,
            //showResults: false,
            finalScores: finalScores,
            rematchInitiator: userId
          });

          // Continuar con el proceso normal de marcar como listo
          return;
        }

        // Proceso normal para iniciar juego
        room.status = 'playing';
        room.players.forEach(playerId => {
          const player = room.playersData[playerId];
        });

        // Combinar preguntas de ambos jugadores
        const allQuestions = [];

        // Agregar preguntas del creador primero (si tiene)
        if (room.pendingQuestions[room.creator.uid]) {
          allQuestions.push(...room.pendingQuestions[room.creator.uid]);
        }

        // Agregar preguntas del segundo jugador
        const secondPlayerId = room.players.find(id => id !== room.creator.uid);
        if (secondPlayerId && room.pendingQuestions[secondPlayerId]) {
          allQuestions.push(...room.pendingQuestions[secondPlayerId]);
        }

        // Si no hay preguntas de los jugadores, usar preguntas por defecto
        if (allQuestions.length === 0) {
          console.log('⚠️ No se recibieron preguntas de los jugadores, usando preguntas por defecto');
          io.to(roomId).emit('gameReadyError', {
            message: 'No se pudieron obtener preguntas para el juego'
          });
          return;
        }

        // Mezclar las preguntas para que no sean predecibles
        const shuffledQuestions = allQuestions.sort(() => Math.random() - 0.5);

        // Tomar solo las primeras 10 preguntas
        room.questions = shuffledQuestions.slice(0, 10);
        room.gameSettings.questionsCount = room.questions.length;

        console.log(`🎮 Juego iniciado con ${room.questions.length} preguntas combinadas`);

        // Preparar preguntas para enviar al cliente (sin respuestas correctas)
        const questionsForClient = room.questions.map(q => ({
          questionId: q.questionId,
          question: q.question,
          answers: q.answers,
          bibleReference: q.bibleReference,
          index: q.index
          // NO enviamos correctAnswer al cliente
        }));

        // Preparar userQuestionIds para cada jugador
        const userQuestionIdsForPlayers = {};
        room.players.forEach(playerId => {
          if (room.playersData[playerId]?.userQuestionIds) {
            userQuestionIdsForPlayers[playerId] = room.playersData[playerId].userQuestionIds;
          } else {
            userQuestionIdsForPlayers[playerId] = [];
          }
        });

        // Notificar a todos que el juego puede comenzar
        io.to(roomId).emit('gameReady', {
          roomId,
          players: room.players,
          playersData: room.playersData,
          creator: room.creator,
          gameSettings: room.gameSettings,
          scores: room.scores,
          questions: questionsForClient,
          userQuestionIds: userQuestionIdsForPlayers // Enviar los IDs de preguntas de cada jugador
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
      //socket.emit('roomStateError', { message: 'La sala no existe' });
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

      // Preparar userQuestionIds para cada jugador
      const userQuestionIdsForPlayers = {};
      room.players.forEach(playerId => {
        if (room.playersData[playerId]?.userQuestionIds) {
          userQuestionIdsForPlayers[playerId] = room.playersData[playerId].userQuestionIds;
        } else {
          userQuestionIdsForPlayers[playerId] = [];
        }
      });

      socket.emit('gameInProgress', {
        roomId,
        players: room.players,
        playersData: room.playersData,
        creator: room.creator,
        gameSettings: room.gameSettings,
        scores: room.scores,
        questions: questionsForClient,
        currentQuestion: room.currentQuestion,
        userQuestionIds: userQuestionIdsForPlayers // Enviar los IDs de preguntas de cada jugador
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

      // Inicializar contador de respuestas correctas si no existe
      if (!room.correctAnswers[userId]) {
        room.correctAnswers[userId] = 0;
      }

      // Actualizar contador de respuestas correctas
      if (isCorrect) {
        room.correctAnswers[userId] += 1;
        console.log(`✅ ${userId} respondió correctamente. Total correctas: ${room.correctAnswers[userId]}`);
      }

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
      const connectedPlayers = room.players.filter(playerId =>
        room.playersData[playerId]?.connected !== false
      );
      const bothAnswered = connectedPlayers.length === 2 && answeredPlayers.length === 2;

      if (bothAnswered) {
        // enviar resultados de la preguntas  
        try {
          io.to(roomId).emit('questionResults', {
            roomId,
            questionIndex,
            answers: room.questionAnswers[questionIndex],
            scores: room.scores,
            correctAnswer: currentQuestion.correctAnswer,
            //indice de la pregunta
            index: currentQuestion.index,
            questionId: currentQuestion.questionId
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
              playersData: room.playersData,
              correctAnswers: room.correctAnswers, // Agregar esta línea
              totalQuestions: room.questions.length // Agregar esta línea
            });
            console.log('juego terminado0000000000000 en el servidor')
            console.log('🏁 Juego terminado. Respuestas correctas por jugador:', room.correctAnswers);

            // Programar limpieza automática después de 10 minutos si nadie sale
            const cleanupTimeout = setTimeout(() => {
              const roomToClean = gameRooms.get(roomId);
              if (roomToClean && roomToClean.status === 'finished') {
                gameRooms.delete(roomId);
                console.log(`🧹 Sala ${roomId} limpiada automáticamente después de 10 minutos`);
              }
            }, 600000); // 10 minutos

            roomTimeouts.set(roomId, cleanupTimeout);
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
          waitingFor: connectedPlayers.filter(p => !answeredPlayers.includes(p))
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
            // Solo programar eliminación si el juego está en espera o terminado
            if (room.status === 'waiting') {
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
              console.log(`Programada eliminación de sala ${socket.roomId} en 5 minutos (solo si está en espera)`);
            } else if (room.status === 'finished') {
              // Si el juego terminó, mantener la sala por 10 minutos para que los jugadores puedan ver resultados
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
                    console.log(`Sala ${socket.roomId} eliminada después del juego terminado`);
                  }
                }
              }, 600000); // 10 minutos de gracia para salas terminadas

              roomTimeouts.set(socket.roomId, timeout);
              console.log(`Programada eliminación de sala ${socket.roomId} en 10 minutos (juego terminado)`);
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
          console.log(`Sala ${roomId} eliminada (último jugador salió)`);
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

  // Evento para limpiar sala cuando termine el juego
  socket.on('cleanupRoom', (data) => {
    const { roomId } = data;
    const room = gameRooms.get(roomId);

    if (room) {
      // Cancelar timeout si existe
      if (roomTimeouts.has(roomId)) {
        clearTimeout(roomTimeouts.get(roomId));
        roomTimeouts.delete(roomId);
      }

      // Eliminar la sala inmediatamente
      gameRooms.delete(roomId);
      console.log(`🧹 Sala ${roomId} limpiada después del juego`);

      // Notificar a todos los jugadores que la sala fue eliminada
      io.to(roomId).emit('roomCleaned', {
        roomId,
        message: 'Sala eliminada después del juego'
      });
    }
  });

  // Evento para salir después del juego terminado
  socket.on('leaveAfterGame', (data) => {
    const { roomId, userId } = data;
    const room = gameRooms.get(roomId);

    if (room && room.status === 'finished') {
      const playerIndex = room.players.indexOf(userId);
      if (playerIndex > -1) {
        room.players.splice(playerIndex, 1);
        delete room.playersData[userId];

        console.log(`👋 Jugador ${userId} salió después del juego terminado de sala ${roomId}`);

        // Si no quedan jugadores, eliminar la sala inmediatamente
        if (room.players.length === 0) {
          // Cancelar timeout si existe
          if (roomTimeouts.has(roomId)) {
            clearTimeout(roomTimeouts.get(roomId));
            roomTimeouts.delete(roomId);
          }

          gameRooms.delete(roomId);
          console.log(`🧹 Sala ${roomId} eliminada después de que todos salieron del juego terminado`);
        }
      }
    }

    socket.leave(roomId);
  });

  // Evento para forzar limpieza de salas (para debugging)
  socket.on('forceCleanup', (data) => {
    const { roomId } = data;
    const room = gameRooms.get(roomId);

    if (room) {
      // Cancelar timeout si existe
      if (roomTimeouts.has(roomId)) {
        clearTimeout(roomTimeouts.get(roomId));
        roomTimeouts.delete(roomId);
      }

      // Eliminar la sala
      gameRooms.delete(roomId);
      console.log(`🧹 Sala ${roomId} forzada a limpiar`);

      // Notificar a todos los jugadores
      io.to(roomId).emit('roomCleaned', {
        roomId,
        message: 'Sala forzada a limpiar'
      });
    }
  });
  // Evento para reiniciar el juego
  socket.on('gameStateReset', (data) => {
    const { roomId, shouldShowResults = false } = data;
    const room = gameRooms.get(roomId);

    if (room) {
      // Preservar los scores finales antes de resetear
      const finalScores = { ...room.scores };
      const playersData = { ...room.playersData };
      const questionsCount = room.questions.length; // Preservar el número de preguntas

      // Resetear solo el estado del juego, NO los jugadores
      room.status = 'waiting';
      // NO limpiar room.players ni room.playersData
      room.questionAnswers = {};
      room.scores = {};
      room.currentQuestion = 0;
      room.questions = [];

      // LIMPIAR LAS PREGUNTAS PENDIENTES PARA FORZAR NUEVAS PREGUNTAS
      room.pendingQuestions = {};
      room.correctAnswers = {}; // Limpiar respuestas correctas

      // Resetear el estado "ready" de todos los jugadores
      Object.keys(room.playersData).forEach(playerId => {
        if (room.playersData[playerId]) {
          room.playersData[playerId].ready = false;
          // También limpiar los userQuestionIds para forzar nuevas preguntas
          room.playersData[playerId].userQuestionIds = [];
        }
      });

      console.log(`🔄 Sala ${roomId} reiniciada (jugadores preservados, preguntas limpiadas)`);

      // Solo enviar finalScores si se solicita explícitamente
      const resetData = {
        roomId,
        message: 'Juego reiniciado',
        players: room.players, // Incluir la lista de jugadores
        playersData: playersData,
        creator: room.creator, // Incluir la información del creador
        gameSettings: room.gameSettings, // Incluir la configuración del juego
        questionsCount: questionsCount,
        //showResults: shouldShowResults
      };

      if (shouldShowResults && Object.keys(finalScores).length > 0) {
        resetData.finalScores = finalScores;
      }

      // Notificar a todos los jugadores
      io.to(roomId).emit('gameStateReset', resetData);
    }
  });

  // Evento para solicitar sincronización del estado de resultados
  socket.on('requestResultsSync', (data) => {
    const { roomId, userId } = data;
    const room = gameRooms.get(roomId);

    if (room) {
      // Determinar si se deben mostrar resultados basado en el estado de la sala
      const shouldShowResults = room.status === 'finished' && Object.keys(room.scores).length > 0;

      const syncData = {
        roomId,
        showResults: shouldShowResults
      };

      if (shouldShowResults) {
        syncData.gameResults = {
          scores: room.scores,
          totalQuestions: room.questions.length || 0,
          currentUserId: userId
        };
      }

      // Enviar solo al jugador que solicitó la sincronización
      socket.emit('syncResultsState', syncData);
    }
  });

  // Evento para cuando un jugador está listo para revancha
  socket.on('playerReadyForRematch', (data) => {
    const { roomId, userId } = data;
    const room = gameRooms.get(roomId);

    if (room && room.playersData[userId]) {
      // Marcar solo este jugador como listo para revancha
      room.playersData[userId].readyForRematch = true;
      room.playersData[userId].ready = false; // Resetear el estado de listo

      console.log(`🔄 Jugador ${userId} listo para revancha en sala ${roomId}`);

      // Verificar si ambos jugadores están listos para revancha
      const allReadyForRematch = room.players.every(playerId =>
        room.playersData[playerId]?.readyForRematch
      );

      if (allReadyForRematch) {
        // Ambos están listos para revancha, hacer reset completo
        const finalScores = { ...room.scores };
        const playersData = { ...room.playersData };
        const questionsCount = room.questions.length;

        // Resetear el estado del juego
        room.status = 'waiting';
        room.questionAnswers = {};
        room.scores = {};
        room.currentQuestion = 0;
        room.questions = [];
        room.pendingQuestions = {};
        room.correctAnswers = {}; // Limpiar respuestas correctas

        // Resetear el estado "ready" de todos los jugadores
        Object.keys(room.playersData).forEach(playerId => {
          if (room.playersData[playerId]) {
            room.playersData[playerId].ready = false;
            room.playersData[playerId].readyForRematch = false; // Limpiar estado de revancha
            room.playersData[playerId].userQuestionIds = [];
          }
        });

        console.log(`🔄 Sala ${roomId}: Revancha iniciada por ambos jugadores`);

        // Notificar a todos los jugadores que el juego se reinició
        io.to(roomId).emit('gameStateReset', {
          roomId,
          message: 'Juego reiniciado para revancha',
          players: room.players,
          playersData: playersData,
          creator: room.creator,
          gameSettings: room.gameSettings,
          questionsCount: questionsCount,
          //showResults: false, // No mostrar resultados para nadie cuando ambos están listos
          rematchInitiator: userId
        });
      } else {
        // Solo un jugador está listo, notificar actualización
        io.to(roomId).emit('playerStatusUpdated', {
          roomId,
          players: room.players,
          playersData: room.playersData,
          creator: room.creator,
          gameSettings: room.gameSettings
        });
      }
    }
  });

});



// Iniciar servidor
server.listen(PORT || 3000, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  console.log(`📡 Socket.IO habilitado`);
})