#version 120
/*
 * sky_fp.glsl
 * skybox rendering fragment program
 * Copyright (C) 2010  Jens Loehr <jens.loehr@gmx.de>
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 2 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General
 * Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA.
 */

/* uniform variables */
uniform sampler2D u_Texture0;

/* shared variables */
varying vec4 v_TexCoord0;

/*
 * main
 * Entry point for sky fragment program
 */
void main (void) {
	gl_FragColor = texture2D(u_Texture0, vec2(v_TexCoord0));
}
