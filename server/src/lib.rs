use spacetimedb::{reducer, table, Identity, ReducerContext, ScheduleAt, SpacetimeType, Table, TimeDuration};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

const MARGIN: i32 = 5;
const MIN_X: i32 = -MARGIN;
const MIN_Y: i32 = -MARGIN;
const MAX_X: i32 = 192 + MARGIN;
const MAX_Y: i32 = 108 + MARGIN;

#[derive(SpacetimeType)]
struct Cell {
    x: i32,
    y: i32,
}

impl PartialEq for Cell {
    fn eq(&self, other: &Self) -> bool {
        self.x == other.x && self.y == other.y
    }
}

impl Eq for Cell {}

impl Hash for Cell {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.x.hash(state);
        self.y.hash(state);
    }
}

#[table(name = config, public)]
struct Config {
    #[primary_key]
    id: u32,
    tick_interval_ms: u32,
}

#[table(
    name = alive_cells,
    index(name = coordinates, btree(columns = [x, y])),
    public
)]
struct AliveCell {
    x: i32,
    y: i32,
    player_id: u32
}

#[table(name = tick_schedule, scheduled(tick))]
struct TickSchedule {
    #[primary_key]
    scheduled_id: u64,
    scheduled_at: ScheduleAt,
}

#[table(name = players, public)]
struct Player {
    #[primary_key]
    #[auto_inc]
    id: u32,
    #[unique]
    identity: Identity,
    color_hex: String,
}

#[reducer(init)]
fn init(ctx: &ReducerContext) {
    let default_tick_interval_ms = 500;
    ctx.db.config().insert(Config {
        id: 0,
        tick_interval_ms: default_tick_interval_ms,
    });

    let loop_duration: TimeDuration = TimeDuration::from_micros((default_tick_interval_ms * 1000) as i64);
    ctx.db.tick_schedule().insert(TickSchedule {
        scheduled_id: 0,
        scheduled_at: loop_duration.into()
    });
}

#[reducer(client_connected)]
fn identity_connected(ctx: &ReducerContext) {
    if ctx.db.players().identity().find(ctx.sender).is_none() {
        ctx.db.players().insert(Player {
            id: 0,
            identity: ctx.sender,
            color_hex: "#FFFFFF".to_string(),
        });
    }
}

#[reducer(client_disconnected)]
fn identity_disconnected(_ctx: &ReducerContext) {
}

#[reducer]
fn add(ctx: &ReducerContext, cells: Vec<Cell>) {
    let player_id = ctx.db.players().identity().find(ctx.sender).unwrap().id;
    for c in cells {
        ctx.db.alive_cells().insert(AliveCell { x: c.x, y: c.y, player_id: player_id });
    }
}

#[reducer]
fn set_color(ctx: &ReducerContext, color_hex: String) {
    if let Some(p) = ctx.db.players().identity().find(ctx.sender) {
        ctx.db.players().identity().update(Player {
            id: p.id,
            identity: p.identity,
            color_hex: color_hex,
        });
    }
}

#[reducer]
fn update_tick_interval(ctx: &ReducerContext, interval_ms: u32) {
    let mut config = ctx.db.config().id().find(0).unwrap();
    config.tick_interval_ms = interval_ms;
    ctx.db.config().id().update(config);

    let loop_duration: TimeDuration = TimeDuration::from_micros((interval_ms * 1000) as i64);
    
    let mut tick_schedule = ctx.db.tick_schedule().scheduled_id().find(0).unwrap();
    tick_schedule.scheduled_at = loop_duration.into();
    ctx.db.tick_schedule().scheduled_id().update(tick_schedule);
}

#[reducer]
fn tick(ctx: &ReducerContext, _arg: TickSchedule) -> Result<(), String> {
    let mut neighbours_by_cell: HashMap<Cell, Vec<u32>> = HashMap::new();

    for alive_cell in ctx.db.alive_cells().iter() {
        for x in alive_cell.x - 1..=alive_cell.x + 1 {
            for y in alive_cell.y - 1..=alive_cell.y + 1 {
                // make sure to put empty vec as neighbours even for "self" cell before continuing to avoid cell being ignore in later logic
                let neighbors = neighbours_by_cell.entry(Cell{x,y}).or_insert(Vec::new());
                if x == alive_cell.x && y == alive_cell.y {
                    continue;
                }
                neighbors.push(alive_cell.player_id);
            }
        }
    }

    for cell in neighbours_by_cell.keys() {

        let is_alive = ctx.db.alive_cells().coordinates().filter((cell.x, cell.y)).next().is_some();

        // kill cells outside of the canvas
        if is_alive && (cell.x < MIN_X || cell.x > MAX_X || cell.y < MIN_Y || cell.y > MAX_Y) {
            ctx.db.alive_cells().coordinates().delete((cell.x, cell.y));
        }

        let neighbors = neighbours_by_cell.get(cell).unwrap();
        let mut counts: HashMap<u32, u32> = HashMap::new();
        for neighbor in neighbors {
            let count = counts.entry(*neighbor).or_insert(0);
            *count += 1;
        }
        let total_count = neighbors.len();

        if total_count == 3 {
            // count = 3 -> cell becomes (or stays) alive
            if !is_alive {
                let most_common_player_id = counts.iter().max_by_key(|&(_, count)| count).map(|(&player, _)| player).unwrap_or(0);
                ctx.db.alive_cells().insert(AliveCell { x: cell.x, y: cell.y, player_id: most_common_player_id });
            }
        } else if total_count != 2 && is_alive {
            // count != 2 (or 3) -> cell dies
            ctx.db.alive_cells().coordinates().delete((cell.x, cell.y));
        }
    }
    Ok(())
}