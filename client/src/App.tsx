import { useEffect, useRef, useState } from 'react'
import './App.css'
import { Identity } from '@clockworklabs/spacetimedb-sdk';
import { AliveCell, Cell, DbConnection, ErrorContext, EventContext, Player } from './module_bindings';

const CELL_SIZE = 10; // Cell size in pixels
const GRID_COLOR = "#222";
const DEFAULT_LIVE_CELL_COLOR = "#FFFFFF";

function App() {
  const [_connected, setConnected] = useState<boolean>(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [conn, setConn] = useState<DbConnection | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gridSize, _setGridSize] = useState({ width: 1920, height: 1080 });
  const cells = useCells(conn);
  const [pendingCells, setPendingCells] = useState<Cell[]>([]);
  const [selectedColor, setSelectedColor] = useState<string>("#FFFFFF");
  const players = usePlayers(conn);

  useEffect(() => {
    const onConnect = (
      conn: DbConnection,
      identity: Identity,
      token: string
    ) => {
      setIdentity(identity);
      setConnected(true);
      localStorage.setItem('auth_token', token);
      conn?.subscriptionBuilder()
        .onApplied(_e => console.log("Applied subscription"))
        .onError(e => console.error("Error applying subscription", e))
        .subscribe(["SELECT * FROM alive_cells", "SELECT * FROM players"]);
    };

    const onDisconnect = () => {
      console.log('Disconnected from SpacetimeDB');
      setConnected(false);
    };

    const onConnectError = (_conn: ErrorContext, err: Error) => {
      console.log('Error connecting to SpacetimeDB:', err);
    };

    setConn(
      DbConnection.builder()
        .withUri('wss://maincloud.spacetimedb.com')
        .withModuleName('game-of-life')
        .withToken(localStorage.getItem('auth_token') || '')
        .onConnect(onConnect)
        .onDisconnect(onDisconnect)
        .onConnectError(onConnectError)
        .build()
    );
  }, []);

  function useCells(conn: DbConnection | null): AliveCell[] {
    const [cells, setCells] = useState<AliveCell[]>([]);

    useEffect(() => {
      if (!conn) return;
      const onInsert = (_ctx: EventContext, cell: AliveCell) => {
        setCells(prev => [...prev, cell]);
      };
      conn.db.aliveCells.onInsert(onInsert);

      const onDelete = (_ctx: EventContext, cell: AliveCell) => {
        setCells(prev => prev.filter(m => m.x !== cell.x || m.y !== cell.y));
      };
      conn.db.aliveCells.onDelete(onDelete);

      return () => {
        conn.db.aliveCells.removeOnInsert(onInsert);
        conn.db.aliveCells.removeOnDelete(onDelete);
      };
    }, [conn]);

    return cells;
  }

  function usePlayers(conn: DbConnection | null): Map<number, Player> {
    const [players, setPlayers] = useState<Map<number, Player>>(new Map());

    useEffect(() => {
      if (!conn) return;
      const onInsert = (_ctx: EventContext, p: Player) => {
        setPlayers(prev => new Map(prev.set(p.id, p)));
      };
      conn.db.players.onInsert(onInsert);

      const onUpdate = (_ctx: EventContext, oldP: Player, newP: Player) => {
        setPlayers(prev => {
          prev.delete(oldP.id);
          return new Map(prev.set(newP.id, newP));
        });
      };
      conn.db.players.onUpdate(onUpdate);

      const onDelete = (_ctx: EventContext, p: Player) => {
        setPlayers(prev => {
          prev.delete(p.id);
          return new Map(prev);
        });
      };
      conn.db.players.onDelete(onDelete);

      return () => {
        conn.db.players.removeOnInsert(onInsert);
        conn.db.players.removeOnUpdate(onUpdate);
        conn.db.players.removeOnDelete(onDelete);
      };
    }, [conn]);

    return players;
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, gridSize.width, gridSize.height);
    ctx.fillStyle = GRID_COLOR;
    ctx.fillRect(0, 0, gridSize.width, gridSize.height);

    // Draw live cells
    cells.forEach(cell => {
      ctx.fillStyle = players.get(cell.playerId)?.colorHex || DEFAULT_LIVE_CELL_COLOR;
      ctx.fillRect(
        cell.x * CELL_SIZE,
        cell.y * CELL_SIZE,
        CELL_SIZE - 1,
        CELL_SIZE - 1
      );
    });

    // Draw pending cells
    ctx.fillStyle = selectedColor;
    pendingCells.forEach(cell => {
      ctx.fillRect(
        cell.x * CELL_SIZE,
        cell.y * CELL_SIZE,
        CELL_SIZE - 1,
        CELL_SIZE - 1
      );
    });
  }, [cells, pendingCells, gridSize]);

  useEffect(() => {
    if (!conn || !identity) return;
    let color = DEFAULT_LIVE_CELL_COLOR;
    for (const player of players.values()) {
      if (player.identity.isEqual(identity)) {
        color = player.colorHex;
        break;
      }
    }
    setSelectedColor(color);
  }, [players]);

  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Get the canvas bounding box (to handle different screen positions)
    const rect = canvas.getBoundingClientRect();

    // Calculate click position relative to the canvas
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Convert to grid coordinates
    const gridX = Math.floor(x / CELL_SIZE);
    const gridY = Math.floor(y / CELL_SIZE);

    let cell = { x: gridX, y: gridY }
    if (pendingCells.some(c => c.x == cell.x && c.y == cell.y)) {
      setPendingCells(pendingCells.filter(c => c.x != cell.x || c.y != cell.y));
    } else {
      setPendingCells([...pendingCells, cell]);
    }
  };

  const applyPendingCells = () => {
    if (!conn) return;
    conn.reducers.add(pendingCells);
    setPendingCells([]);
  }

  const updateColor = (color: string) => {
    if (!conn) return;
    setSelectedColor(color);
    conn.reducers.setColor(color);
  }

  return (
    <>
      <div className='header'>
        <p>Conway's Game of Space and Time </p>
      </div>
      <div className='disclaimers'>
        <p>Based on <a href="https://en.wikipedia.org/wiki/Conway%27s_Game_of_Life">Conway's Game of Life</a></p>
        <p>|</p>
        <p>Built with <a href="https://spacetimedb.com/">SpacetimeDB</a></p>
      </div>
      <canvas
        ref={canvasRef}
        width={gridSize.width}
        height={gridSize.height}
        onClick={handleCanvasClick}
        style={{ border: "1px solid white" }}
      />
      <div className='tools'>
        <button
          onClick={applyPendingCells}
          disabled={pendingCells.length === 0}
        >Apply pending cells</button>
        <span>Pick color</span>
        <input
          type="color"
          value={selectedColor}
          onChange={(e) => updateColor(e.target.value)}
        />
      </div>
    </>
  )
}

export default App
